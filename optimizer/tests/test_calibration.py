"""Tests for outcome calibration (aop_optimizer.calibration) and its server
integration (/calibrate, /calibration, provenance on scoring responses).

The fit tests use DETERMINISTIC synthetic outcomes (expected wins rounded
from the true curve) — no RNG, no flakes — and assert parameter recovery
within tight tolerances plus every rejection path.
"""

import json
import math
import threading
import unittest
import urllib.error
import urllib.request

from aop_optimizer.calibration import (
    DEFAULT_BASELINE,
    DEFAULT_TEMPERATURE,
    MIN_SESSIONS,
    fit_selection_curve,
)
from aop_optimizer.server import make_server


def _sigmoid(z):
    return 1.0 / (1.0 + math.exp(-z))


def synthetic_samples(baseline, temperature, scores, n_per_score=200):
    """Aggregated outcomes with EXPECTED win counts from the true curve."""
    samples = []
    for score in scores:
        p = _sigmoid((score - baseline) / temperature)
        wins = round(n_per_score * p)
        samples.append({"score": score, "wins": wins, "losses": n_per_score - wins})
    return samples


class FitSelectionCurveTests(unittest.TestCase):
    def test_recovers_known_curve(self):
        samples = synthetic_samples(55.0, 8.0, range(20, 95, 5))
        result = fit_selection_curve(samples)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["mode"], "full")
        self.assertAlmostEqual(result["market_baseline_score"], 55.0, delta=1.0)
        self.assertAlmostEqual(result["probability_temperature"], 8.0, delta=0.8)
        self.assertEqual(result["n_sessions"], 15 * 200)
        # The fitted curve must explain the data at least as well as the
        # hand-tuned default curve (MLE on the training data guarantees it).
        self.assertLessEqual(result["log_loss"], result["default_log_loss"])

    def test_recovers_curve_far_from_defaults(self):
        samples = synthetic_samples(75.0, 20.0, range(10, 100, 5))
        result = fit_selection_curve(samples)
        self.assertTrue(result["ok"], result)
        self.assertAlmostEqual(result["market_baseline_score"], 75.0, delta=1.5)
        self.assertAlmostEqual(result["probability_temperature"], 20.0, delta=1.5)

    def test_insufficient_total_sessions_rejected(self):
        samples = [{"score": 70, "wins": 10, "losses": MIN_SESSIONS - 11}]
        result = fit_selection_curve(samples)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "insufficient_data")

    def test_insufficient_class_count_rejected(self):
        # 200 sessions but only 2 wins: no basis for a curve.
        samples = [{"score": 70, "wins": 2, "losses": 198}]
        result = fit_selection_curve(samples)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "insufficient_data")

    def test_single_score_anchors_intercept_only(self):
        samples = [{"score": 70.0, "wins": 40, "losses": 60}]
        result = fit_selection_curve(samples)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["mode"], "intercept_only")
        self.assertEqual(result["probability_temperature"], DEFAULT_TEMPERATURE)
        # sigmoid((70 - b)/12) must equal the observed 40% win rate.
        expected_b = 70.0 - DEFAULT_TEMPERATURE * math.log(0.4 / 0.6)
        self.assertAlmostEqual(result["market_baseline_score"], expected_b, places=3)
        p = _sigmoid((70.0 - result["market_baseline_score"]) / DEFAULT_TEMPERATURE)
        self.assertAlmostEqual(p, 0.4, places=3)

    def test_inverted_outcomes_rejected_not_fitted(self):
        # Higher scores losing MORE: a defensible fit does not exist.
        samples = [
            {"score": 20, "wins": 180, "losses": 20},
            {"score": 50, "wins": 100, "losses": 100},
            {"score": 80, "wins": 20, "losses": 180},
        ]
        result = fit_selection_curve(samples)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "non_positive_slope")

    def test_perfect_separation_rejected(self):
        # A step function at score 50: quasi-separation must not ship.
        samples = [
            {"score": 40, "wins": 0, "losses": 100},
            {"score": 45, "wins": 0, "losses": 100},
            {"score": 55, "wins": 100, "losses": 0},
            {"score": 60, "wins": 100, "losses": 0},
        ]
        result = fit_selection_curve(samples)
        self.assertFalse(result["ok"], result)
        self.assertIn(result["reason"], ("implausible_fit", "no_convergence"))

    def test_flat_outcomes_rejected_as_implausible(self):
        # Identical win rate at every score: slope -> 0, temperature -> inf.
        samples = [{"score": s, "wins": 50, "losses": 50} for s in (20, 40, 60, 80)]
        result = fit_selection_curve(samples)
        # The MLE slope is exactly 0 and the converged iterate lands within
        # float noise of it, so the reason depends on libm rounding
        # direction: any of the three is a correct refusal.
        self.assertFalse(result["ok"], result)
        self.assertIn(result["reason"], ("implausible_fit", "no_convergence", "non_positive_slope"))

    def test_input_validation(self):
        self.assertEqual(fit_selection_curve(None)["reason"], "samples_not_a_list")
        self.assertEqual(fit_selection_curve(["x"])["reason"], "sample_not_an_object")
        self.assertEqual(
            fit_selection_curve([{"score": float("nan"), "wins": 1, "losses": 1}])["reason"],
            "invalid_score",
        )
        self.assertEqual(
            fit_selection_curve([{"score": 50, "wins": True, "losses": 1}])["reason"],
            "invalid_wins",
        )
        self.assertEqual(
            fit_selection_curve([{"score": 50, "wins": 1, "losses": -1}])["reason"],
            "invalid_losses",
        )
        self.assertEqual(
            fit_selection_curve([{"score": 50, "wins": 1.5, "losses": 1}])["reason"],
            "invalid_wins",
        )

    def test_out_of_range_scores_rejected_not_fitted(self):
        # A fat-fingered score (9999) or garbage (1e15) saturates the sigmoid
        # so hard it can stall the fit at the warm start while claiming
        # success — the bound rejects the row before it can poison anything.
        clean = synthetic_samples(55.0, 8.0, range(20, 95, 5))
        for poison in (9999, 1e15, -1e15, 300.01):
            samples = clean + [{"score": poison, "wins": 100, "losses": 100}]
            result = fit_selection_curve(samples)
            self.assertFalse(result["ok"], poison)
            self.assertEqual(result["reason"], "invalid_score", poison)

    def test_huge_counts_rejected_instead_of_overflowing(self):
        # int->float conversion inside the likelihood overflows around 1.8e308;
        # the never-raises contract demands a clean rejection, not a traceback.
        result = fit_selection_curve([{"score": 50, "wins": 10**400, "losses": 10**400}])
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "invalid_wins")

    def test_accepted_fit_sits_at_a_zero_gradient(self):
        # First-order optimality: an accepted 'full' fit must NOT be a
        # backtracking stall at the warm start (log_loss == default_log_loss
        # with defaults echoed back would be the fingerprint of that bug).
        samples = synthetic_samples(40.0, 5.0, range(20, 95, 5))
        result = fit_selection_curve(samples)
        self.assertTrue(result["ok"], result)
        self.assertLess(result["log_loss"], result["default_log_loss"])
        self.assertNotAlmostEqual(result["market_baseline_score"], DEFAULT_BASELINE, delta=1.0)

    def test_zero_weight_rows_are_skipped_not_fatal(self):
        samples = synthetic_samples(55.0, 8.0, range(20, 95, 5))
        samples.append({"score": 99.0, "wins": 0, "losses": 0})
        result = fit_selection_curve(samples)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["n_sessions"], 15 * 200)


class CalibrationServerTests(unittest.TestCase):
    """Server integration on a dedicated instance (calibration is per-server
    state; sharing test_server.py's instance would leak curves across suites).
    """

    @classmethod
    def setUpClass(cls):
        cls.server = make_server(port=0)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def _request(self, method, path, body=None, headers=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        all_headers = {}
        if data:
            all_headers["Content-Type"] = "application/json"
        if path == "/calibrate" and headers is None:
            # State-mutating endpoints require the CSRF-defeating header
            # (custom headers force a preflight browsers cannot pass).
            all_headers["X-AOP-Calibrate"] = "1"
        all_headers.update(headers or {})
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=data,
            headers=all_headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())

    def test_full_calibration_lifecycle(self):
        # 0. Defaults before any fit.
        status, body = self._request("GET", "/calibration")
        self.assertEqual(status, 200)
        self.assertEqual(body["source"], "default")
        self.assertEqual(body["market_baseline_score"], DEFAULT_BASELINE)

        # 1. Scoring reports default provenance (per-field disclosure).
        status, body = self._request("POST", "/score", {"policy_text": "Ships in 2 days."})
        self.assertEqual(status, 200)
        self.assertEqual(
            body["calibration"],
            {"source": "default", "baseline_source": "default", "temperature_source": "default"},
        )

        # 2. Accepted fit becomes the active curve.
        samples = synthetic_samples(50.0, 10.0, range(20, 95, 5))
        status, body = self._request("POST", "/calibrate", {"sessions": samples})
        self.assertEqual(status, 200, body)
        self.assertTrue(body["ok"])
        fitted_baseline = body["market_baseline_score"]
        self.assertAlmostEqual(fitted_baseline, 50.0, delta=1.5)

        status, body = self._request("GET", "/calibration")
        self.assertEqual(body["source"], "fitted")
        self.assertEqual(body["market_baseline_score"], fitted_baseline)

        # 3. Scoring now uses the fitted curve and says so.
        status, scored = self._request("POST", "/score", {"policy_text": "Ships in 2 days."})
        self.assertEqual(scored["calibration"]["source"], "fitted")
        self.assertEqual(scored["calibration"]["n_sessions"], 15 * 200)
        # The probability must actually come from the fitted curve.
        expected_p = _sigmoid(
            (scored["agent_match_score"] - fitted_baseline) / body["probability_temperature"]
        )
        self.assertAlmostEqual(scored["selection_probability"], expected_p, places=4)

        # 4. Explicit request values override PER FIELD: the overridden
        # baseline applies NUMERICALLY, and the unspecified temperature
        # stays FITTED (not silently reset to the default) — with both
        # origins disclosed.
        status, overridden = self._request(
            "POST", "/score", {"policy_text": "Ships in 2 days.", "baseline": 90}
        )
        self.assertEqual(overridden["calibration"]["source"], "request_override")
        self.assertEqual(overridden["calibration"]["baseline_source"], "request")
        self.assertEqual(overridden["calibration"]["temperature_source"], "fitted")
        expected_override_p = _sigmoid(
            (overridden["agent_match_score"] - 90) / body["probability_temperature"]
        )
        self.assertAlmostEqual(overridden["selection_probability"], expected_override_p, places=4)

        # 5. A REJECTED fit leaves the active curve untouched.
        status, rejected = self._request(
            "POST", "/calibrate", {"sessions": [{"score": 50, "wins": 1, "losses": 1}]}
        )
        self.assertEqual(status, 422)
        self.assertEqual(rejected["error"], "calibration_rejected")
        self.assertEqual(rejected["reason"], "insufficient_data")
        status, body = self._request("GET", "/calibration")
        self.assertEqual(body["source"], "fitted")

        # 6. DELETE resets to defaults.
        status, body = self._request("DELETE", "/calibrate")
        self.assertEqual(status, 200)
        status, body = self._request("GET", "/calibration")
        self.assertEqual(body["source"], "default")
        status, body = self._request("POST", "/score", {"policy_text": "Ships in 2 days."})
        self.assertEqual(
            body["calibration"],
            {"source": "default", "baseline_source": "default", "temperature_source": "default"},
        )

    def test_calibrate_mutations_require_the_csrf_header(self):
        # Without X-AOP-Calibrate: 1 both mutating verbs refuse — a browser
        # can never add the header cross-origin (preflight fails on it).
        status, body = self._request("POST", "/calibrate", {"sessions": []}, headers={})
        self.assertEqual(status, 403)
        status, body = self._request("DELETE", "/calibrate", headers={})
        self.assertEqual(status, 403)
        # Read-only scoring stays open: no header needed.
        status, body = self._request("POST", "/score", {"policy_text": "Ships fast."})
        self.assertEqual(status, 200)

    def test_calibrate_honors_optional_bearer_token(self):
        import os
        from unittest.mock import patch

        with patch.dict(os.environ, {"AOP_OPTIMIZER_TOKEN": "cal-secret"}):
            status, body = self._request("DELETE", "/calibrate")  # header, no token
            self.assertEqual(status, 401)
            status, body = self._request(
                "DELETE", "/calibrate",
                headers={"X-AOP-Calibrate": "1", "Authorization": "Bearer cal-secret"},
            )
            self.assertEqual(status, 200)

    def test_non_finite_overrides_are_rejected(self):
        # json.loads accepts NaN/Infinity tokens; they must 400, not silently
        # score on engine defaults while claiming request_override.
        for bad in ("NaN", "Infinity", "-Infinity"):
            raw = ('{"policy_text": "Ships fast.", "baseline": ' + bad + "}").encode("utf-8")
            request = urllib.request.Request(
                f"http://127.0.0.1:{self.port}/score",
                data=raw,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request) as response:
                    status = response.status
            except urllib.error.HTTPError as err:
                status = err.code
            self.assertEqual(status, 400, bad)

    def test_calibrate_requires_json(self):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/calibrate",
            data=b"not json",
            headers={"Content-Type": "application/json", "X-AOP-Calibrate": "1"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request) as response:
                status = response.status
        except urllib.error.HTTPError as err:
            status = err.code
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
