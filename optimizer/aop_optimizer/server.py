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
    POST /calibrate {"sessions": [{"score": n, "wins": n, "losses": n}, ...]}
                   -> outcome calibration (calibration.py): fits the
                      selection curve from real won/lost sessions and, on an
                      accepted fit, makes it the server's active curve. A
                      rejected fit (insufficient data, inverted slope,
                      implausible parameters) changes NOTHING and answers 422
                      with the reason.
    GET  /calibration -> the active curve + provenance
    DELETE /calibrate -> drop the fitted curve, back to defaults
    GET  /healthz  -> {"status": "ok"} liveness probe

The two state-MUTATING endpoints (POST/DELETE /calibrate) require the
X-AOP-Calibrate: 1 request header — a custom header forces a CORS preflight
that this server's Allow-Headers will fail, so a drive-by web page can never
recalibrate the curve cross-origin — and, when AOP_OPTIMIZER_TOKEN is set, a
matching bearer token as well. The read-only scoring endpoints stay open.

Scoring endpoints resolve baseline/temperature PER FIELD in this order:
explicit request-body value (operator override) > the fitted calibration >
the hand-tuned default — and every scoring response carries a "calibration"
provenance object naming each field's origin.

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

import hmac
import json
import math
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple

from .calibration import DEFAULT_BASELINE, DEFAULT_TEMPERATURE, fit_selection_curve
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

    # baseline/temperature stay None when ABSENT: the handler then falls
    # back to the fitted calibration (if any) and finally the defaults.
    # Explicit values remain an operator override and must validate.
    def _num(name: str) -> Tuple[Optional[float], bool]:
        if name not in data:
            return None, True
        value = data.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None, False
        # json.loads accepts NaN/Infinity tokens; a non-finite override would
        # silently degrade to engine defaults while provenance claimed
        # "request_override" — reject it here instead.
        if not math.isfinite(float(value)):
            return None, False
        return float(value), True

    baseline, baseline_ok = _num("baseline")
    temperature, temperature_ok = _num("temperature")
    if not baseline_ok:
        return None, "baseline must be a number"
    if not temperature_ok or (temperature is not None and temperature <= 0):
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
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    # ------------------------------------------------------- calibration
    def _get_calibration(self) -> Optional[Dict[str, Any]]:
        with self.server.calibration_lock:  # type: ignore[attr-defined]
            return self.server.calibration  # type: ignore[attr-defined]

    def _set_calibration(self, value: Optional[Dict[str, Any]]) -> None:
        with self.server.calibration_lock:  # type: ignore[attr-defined]
            self.server.calibration = value  # type: ignore[attr-defined]

    def _resolve_curve(self, params: Dict[str, Any]) -> Tuple[float, float, Dict[str, Any]]:
        """Effective (baseline, temperature, provenance) for one request.

        Resolution is PER FIELD: request value > fitted calibration >
        hand-tuned default, independently for baseline and temperature — an
        operator probing "what if the baseline were 55?" against a
        calibrated server keeps the FITTED temperature, not the default.
        Provenance discloses each field's origin so a stored report can
        never silently mix layers.
        """
        fitted = self._get_calibration()

        def resolve(request_value: Optional[float], fitted_key: str, default: float) -> Tuple[float, str]:
            if request_value is not None:
                return request_value, "request"
            if fitted is not None:
                return fitted[fitted_key], "fitted"
            return default, "default"

        baseline, baseline_source = resolve(params["baseline"], "market_baseline_score", DEFAULT_BASELINE)
        temperature, temperature_source = resolve(
            params["temperature"], "probability_temperature", DEFAULT_TEMPERATURE
        )
        sources = (baseline_source, temperature_source)
        source = "request_override" if "request" in sources else ("fitted" if "fitted" in sources else "default")
        provenance: Dict[str, Any] = {
            "source": source,
            "baseline_source": baseline_source,
            "temperature_source": temperature_source,
        }
        if "fitted" in sources and fitted is not None:
            provenance.update(
                {
                    "mode": fitted["mode"],
                    "n_sessions": fitted["n_sessions"],
                    "log_loss": fitted["log_loss"],
                    "default_log_loss": fitted["default_log_loss"],
                }
            )
        return baseline, temperature, provenance

    def _calibrate_authorized(self) -> bool:
        """Gate for the state-MUTATING /calibrate endpoints.

        Two layers:
          - X-AOP-Calibrate: 1 must be present. A custom request header
            forces browsers into a CORS preflight, and this server's
            Allow-Headers only lists Content-Type — so a drive-by web page
            can never send it cross-origin (the scoring endpoints stay
            wide-open by design; they mutate nothing). curl/operators just
            add the header.
          - If AOP_OPTIMIZER_TOKEN is set in the environment, a matching
            bearer token is also required (constant-time compare) — for
            deployments that expose the port beyond 127.0.0.1.
        """
        if self.headers.get("X-AOP-Calibrate") != "1":
            self._send_json(403, {"error": "calibration requires the X-AOP-Calibrate: 1 header"})
            return False
        expected = os.environ.get("AOP_OPTIMIZER_TOKEN", "").strip()
        if expected:
            match = re.match(r"^Bearer\s+(.+)$", self.headers.get("Authorization", "") or "", re.IGNORECASE)
            presented = match.group(1).strip() if match else ""
            if not hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8")):
                self._send_json(401, {"error": "unauthorized"})
                return False
        return True

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
        if self.path == "/calibration":
            fitted = self._get_calibration()
            if fitted is None:
                self._send_json(
                    200,
                    {
                        "source": "default",
                        "market_baseline_score": DEFAULT_BASELINE,
                        "probability_temperature": DEFAULT_TEMPERATURE,
                    },
                )
            else:
                self._send_json(200, {"source": "fitted", **fitted})
            return
        self._send_json(404, {"error": "not found"})

    def do_DELETE(self) -> None:  # noqa: N802
        if self.path != "/calibrate":
            self._send_json(404, {"error": "not found"})
            return
        if not self._calibrate_authorized():
            return
        self._set_calibration(None)
        self._send_json(200, {"source": "default", "reset": True})

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in ("/score", "/rewrite", "/simulate", "/claims", "/calibrate"):
            self._send_json(404, {"error": "not found"})
            return
        body = self._read_body()
        if body is None:
            return

        if self.path == "/calibrate":
            if not self._calibrate_authorized():
                return
            try:
                data = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(400, {"error": "request body must be valid JSON"})
                return
            sessions = data.get("sessions") if isinstance(data, dict) else None
            result = fit_selection_curve(sessions)
            if not result.get("ok"):
                # A rejected fit changes NOTHING: the active curve (fitted or
                # default) stays. 422: the request was well-formed, the DATA
                # cannot support a defensible curve.
                self._send_json(422, {"error": "calibration_rejected", **result})
                return
            self._set_calibration(result)
            self._send_json(200, result)
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
        baseline, temperature, provenance = self._resolve_curve(params)
        try:
            if self.path == "/simulate":
                payload = _run_simulation(params["policy_text"], baseline, temperature)
            else:
                payload = _run_pipeline(
                    params["policy_text"],
                    baseline,
                    temperature,
                    with_jsonld=(self.path == "/rewrite"),
                )
        except Exception as exc:  # pragma: no cover — pipeline is non-raising
            # The engine contract is non-raising, but an HTTP wrapper must
            # never crash the worker thread on a surprise.
            self._send_json(500, {"error": f"internal error: {exc}"})
            return
        # Server-layer envelope (not part of the directive schema): which
        # curve produced these probabilities.
        payload["calibration"] = provenance
        self._send_json(200, payload)

    def log_message(self, fmt: str, *args: Any) -> None:
        # Route access logs to stderr with a stable prefix (greppable, and
        # keeps stdout clean for anything piping the process).
        sys.stderr.write("[optimizer-server] %s - %s\n" % (self.address_string(), fmt % args))


def make_server(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> ThreadingHTTPServer:
    """Build (but do not start) the server — tests bind port 0 through this."""
    server = ThreadingHTTPServer((host, port), OptimizerRequestHandler)
    # Calibration state lives on the server object (NOT the module): each
    # server instance owns its curve, and the threading server needs the lock
    # because /calibrate can race scoring requests.
    server.calibration = None  # type: ignore[attr-defined]
    server.calibration_lock = threading.Lock()  # type: ignore[attr-defined]
    return server


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
