"""Tests for the optimizer HTTP microservice (aop_optimizer.server).

Boots a real ThreadingHTTPServer on an ephemeral port and drives it with
urllib — no external deps, no fixed ports, safe in CI.
"""

import json
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from aop_optimizer.server import make_server


class ServerTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_server(port=0)  # ephemeral port
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    # ------------------------------------------------------------------ util
    def _post(self, path, body, raw=False, headers=None):
        data = body if raw else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=data,
            headers={"Content-Type": "application/json", **(headers or {})},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read()), dict(response.headers)
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read()), dict(err.headers)

    # ------------------------------------------------------------- happy path
    def test_healthz(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/healthz") as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read()), {"status": "ok"})

    def test_score_returns_directive_payload(self):
        status, payload, headers = self._post(
            "/score", {"policy_text": "14-day returns. Ships in 4-6 business days."}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["schema_version"], "1.0.0")
        self.assertIn("agent_match_score", payload)
        self.assertNotIn("policy_jsonld", payload, "/score omits the rewrite artifact")
        self.assertIsNone(headers.get("Access-Control-Allow-Origin"))

    def test_optimizer_token_protects_scoring_endpoints(self):
        with patch.dict("os.environ", {"AOP_OPTIMIZER_TOKEN": "test-secret"}):
            status, payload, _ = self._post("/score", {"policy_text": "14-day returns"})
            self.assertEqual(status, 401)
            self.assertEqual(payload, {"error": "unauthorized"})
            status, _, _ = self._post("/score", {"policy_text": "14-day returns"}, headers={"Authorization": "Bearer test-secret"})
            self.assertEqual(status, 200)

    def test_rewrite_includes_jsonld_artifact(self):
        status, payload, _ = self._post(
            "/rewrite",
            {"policy_text": "15% restocking fee. Returns within 14 days for store credit only."},
        )
        self.assertEqual(status, 200)
        artifact = payload["policy_jsonld"]
        self.assertEqual(artifact["current"]["@context"], "https://schema.org")
        self.assertEqual(artifact["optimized"]["returnPolicy"]["merchantReturnDays"], 30)
        self.assertIn("rewritten_policy_text", artifact)

    def test_custom_baseline_shifts_probability(self):
        text = {"policy_text": "45-day returns. 2-day shipping. Free shipping on all orders."}
        _, at_default, _ = self._post("/score", text)
        _, at_hundred, _ = self._post("/score", {**text, "baseline": 100})
        self.assertGreater(at_default["selection_probability"], at_hundred["selection_probability"])
        self.assertEqual(at_hundred["selection_probability"], 0.5, "score == baseline -> 0.5")

    # ------------------------------------------------------------ error paths
    def test_missing_policy_text_is_400(self):
        status, payload, _ = self._post("/score", {"nope": 1})
        self.assertEqual(status, 400)
        self.assertIn("policy_text", payload["error"])

    def test_malformed_json_is_400(self):
        status, payload, _ = self._post("/score", b"{not json", raw=True)
        self.assertEqual(status, 400)
        self.assertIn("JSON", payload["error"])

    def test_bad_temperature_is_400(self):
        status, _, _ = self._post("/score", {"policy_text": "x", "temperature": 0})
        self.assertEqual(status, 400)

    def test_unknown_path_is_404(self):
        status, _, _ = self._post("/nope", {"policy_text": "x"})
        self.assertEqual(status, 404)

    def test_options_preflight(self):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/score", method="OPTIONS"
        )
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.status, 204)
            self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))
            self.assertIn("POST", response.headers.get("Access-Control-Allow-Methods", ""))


    # ------------------------------------------------------- what-if simulator
    def test_simulate_returns_baseline_and_scenarios(self):
        status, payload, _ = self._post(
            "/simulate",
            {"policy_text": "15% restocking fee. Returns within 14 days. Ships in 4-6 business days."},
        )
        self.assertEqual(status, 200)
        self.assertIn("baseline", payload)
        self.assertIn("agent_match_score", payload["baseline"])
        codes = [s["code"] for s in payload["scenarios"]]
        self.assertIn("REMOVE_RESTOCKING_FEE", codes)
        self.assertEqual(codes[-1], "FULLY_OPTIMIZED")
        for scenario in payload["scenarios"]:
            self.assertGreaterEqual(scenario["score_delta"], 0)

    def test_simulate_validates_like_the_other_endpoints(self):
        status, payload, _ = self._post("/simulate", {"policy_text": "  "})
        self.assertEqual(status, 400)
        self.assertIn("policy_text", payload["error"])


    # ------------------------------------------------------ claim injector
    def test_claims_audits_and_injects(self):
        status, payload, _ = self._post(
            "/claims",
            {"product": {"title": "Tee", "sku": "T1", "description": "GOTS certified, made in Portugal, 30 cm by 40 cm, 0.2 kg, 1-year warranty", "gtin": "0012345678905", "material": "cotton"}},
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["claims_score"], 100)
        self.assertEqual(payload["product_jsonld"]["@type"], "Product")
        self.assertEqual(payload["injection_directives"], [])

    def test_claims_requires_a_product_object(self):
        status, payload, _ = self._post("/claims", {"product": "not-an-object"})
        self.assertEqual(status, 400)
        self.assertIn("product", payload["error"])


if __name__ == "__main__":
    unittest.main()
