"""server.py — stdlib HTTP microservice wrapping the optimization engine.

Role in the AOP data flow:
    [merchant dashboard "Data Optimizer" tab] --HTTP POST--> THIS SERVER
        -> parse_policy_semantics() -> AgentOptimizationEngine.evaluate()
        -> build_directive_payload() (+ build_policy_jsonld for /rewrite)

The dashboard is a browser SPA and the engine is Python, so this thin HTTP
seam (Sprint 6: "deploy the Semantic Policy Rewriter tool within the app
admin panel") exposes exactly two POST endpoints:

    POST /score    {"policy_text": "...", "baseline"?: n, "temperature"?: n}
                   -> the standard directive payload (schema_version 1.0.0)
    POST /rewrite  same request body
                   -> directive payload + "policy_jsonld" (current/optimized
                      schema.org blocks + rewritten_policy_text)
    POST /claims   {"product": {...}}
                   -> the Structured Claim Injector: audit of agent-favored
                      claims (dimensions, certifications, durability, GTIN,
                      ...), a schema.org Product JSON-LD with every present
                      claim injected, and directives for the gaps
    POST /simulate same request body
                   -> the Pricing & Policy What-If Simulator: baseline score
                      plus counterfactual scenarios (extend returns, faster
                      shipping, drop each penalty, free shipping, ceiling),
                      each with score/probability deltas
    GET  /healthz  -> {"status": "ok"} liveness probe

Design constraints:
  - STDLIB ONLY (http.server) — the optimizer package has zero runtime deps
    and the server keeps that guarantee.
  - This is an internal admin-panel backend, expected to sit behind the
    merchant app's auth/reverse proxy — it binds 127.0.0.1 by default.
  - Permissive CORS (Access-Control-Allow-Origin: *) because the local
    dashboard dev server runs on a different port; the payload is derived
    entirely from the caller's own request body, so cross-origin readability
    leaks nothing.
  - Bounded request bodies (256KB) and JSON error responses with correct
    status codes; a scoring failure can never take the process down.

Run:  python3 -m aop_optimizer.server            # 127.0.0.1:8899
      AOP_OPTIMIZER_PORT=9000 python3 -m aop_optimizer.server
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple

from .directives import build_directive_payload
from .jsonld import build_policy_jsonld
from .scoring import AgentOptimizationEngine
from .semantics import parse_policy_semantics
from .simulator import simulate_variations
from .claims import build_claims_payload

#: Hard cap on accepted request bodies. Policy text is a few KB; anything
#: beyond this is a mistake or abuse, not a policy.
MAX_BODY_BYTES = 256 * 1024

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8899


def _run_pipeline(policy_text: str, baseline: float, temperature: float, with_jsonld: bool) -> Dict[str, Any]:
    """One scoring pass; the same pipeline the CLI runs."""
    metrics = parse_policy_semantics(policy_text)
    engine = AgentOptimizationEngine(
        market_baseline_score=baseline,
        probability_temperature=temperature,
    )
    report = engine.evaluate(metrics)
    payload = build_directive_payload(metrics, report)
    if with_jsonld:
        payload["policy_jsonld"] = build_policy_jsonld(metrics, report)
    return payload


def _run_simulation(policy_text: str, baseline: float, temperature: float) -> Dict[str, Any]:
    """What-if pass: same parse + engine config, counterfactual variations."""
    metrics = parse_policy_semantics(policy_text)
    engine = AgentOptimizationEngine(
        market_baseline_score=baseline,
        probability_temperature=temperature,
    )
    return simulate_variations(metrics, engine)


def _parse_request(body: bytes) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Decode and validate the request body; returns (params, error)."""
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, "request body must be valid JSON"
    if not isinstance(data, dict):
        return None, "request body must be a JSON object"

    policy_text = data.get("policy_text")
    if not isinstance(policy_text, str) or not policy_text.strip():
        return None, "policy_text (non-empty string) is required"

    def _num(name: str, default: float) -> Optional[float]:
        value = data.get(name, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return float(value)

    baseline = _num("baseline", 62.0)
    temperature = _num("temperature", 12.0)
    if baseline is None:
        return None, "baseline must be a number"
    if temperature is None or temperature <= 0:
        return None, "temperature must be a number > 0"

    return {"policy_text": policy_text, "baseline": baseline, "temperature": temperature}, None


class OptimizerRequestHandler(BaseHTTPRequestHandler):
    """Request handler for the two scoring endpoints + health probe."""

    # Identify the service without leaking Python/http.server versions.
    server_version = "aop-optimizer"
    sys_version = ""

    # ------------------------------------------------------------------ util
    def _send_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _read_body(self) -> Optional[bytes]:
        """Bounded body read; None means the request was already rejected."""
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(411, {"error": "invalid Content-Length"})
            return None
        if length <= 0:
            self._send_json(400, {"error": "request body required"})
            return None
        if length > MAX_BODY_BYTES:
            self._send_json(413, {"error": f"body exceeds {MAX_BODY_BYTES} bytes"})
            return None
        return self.rfile.read(length)

    # ------------------------------------------------------------- handlers
    def do_OPTIONS(self) -> None:  # noqa: N802 (http.server naming)
        self.send_response(204)
        self._send_cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._send_json(200, {"status": "ok"})
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in ("/score", "/rewrite", "/simulate", "/claims"):
            self._send_json(404, {"error": "not found"})
            return
        body = self._read_body()
        if body is None:
            return

        if self.path == "/claims":
            # Claims take a product record, not policy text — separate parse.
            try:
                data = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(400, {"error": "request body must be valid JSON"})
                return
            product = data.get("product") if isinstance(data, dict) else None
            if not isinstance(product, dict):
                self._send_json(400, {"error": "product (JSON object) is required"})
                return
            try:
                self._send_json(200, build_claims_payload(product))
            except Exception as exc:  # pragma: no cover — payload builder is non-raising
                self._send_json(500, {"error": f"internal error: {exc}"})
            return

        params, error = _parse_request(body)
        if error is not None:
            self._send_json(400, {"error": error})
            return
        try:
            if self.path == "/simulate":
                payload = _run_simulation(
                    params["policy_text"], params["baseline"], params["temperature"]
                )
            else:
                payload = _run_pipeline(
                    params["policy_text"],
                    params["baseline"],
                    params["temperature"],
                    with_jsonld=(self.path == "/rewrite"),
                )
        except Exception as exc:  # pragma: no cover — pipeline is non-raising
            # The engine contract is non-raising, but an HTTP wrapper must
            # never crash the worker thread on a surprise.
            self._send_json(500, {"error": f"internal error: {exc}"})
            return
        self._send_json(200, payload)

    def log_message(self, fmt: str, *args: Any) -> None:
        # Route access logs to stderr with a stable prefix (greppable, and
        # keeps stdout clean for anything piping the process).
        sys.stderr.write("[optimizer-server] %s - %s\n" % (self.address_string(), fmt % args))


def make_server(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> ThreadingHTTPServer:
    """Build (but do not start) the server — tests bind port 0 through this."""
    return ThreadingHTTPServer((host, port), OptimizerRequestHandler)


def main() -> int:
    host = os.environ.get("AOP_OPTIMIZER_HOST", DEFAULT_HOST)
    port_raw = os.environ.get("AOP_OPTIMIZER_PORT", str(DEFAULT_PORT))
    try:
        port = int(port_raw)
        if not 0 < port < 65536:
            raise ValueError
    except ValueError:
        print(f"aop_optimizer.server: invalid AOP_OPTIMIZER_PORT {port_raw!r}", file=sys.stderr)
        return 2

    server = make_server(host, port)
    print(f"[optimizer-server] listening on http://{host}:{port}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":  # pragma: no cover — exercised via subprocess
    sys.exit(main())
