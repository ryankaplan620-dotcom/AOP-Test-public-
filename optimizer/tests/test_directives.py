"""
AOP :: optimizer/tests/test_directives.py
=========================================

Unit tests for the directive payload builder (directives.py) and the CLI
(__main__.py).  Covers the schema_version 1.0.0 payload shape, directive
gain-consistency (sum of projected gains == 100 - score for non-clamped
policies), exact-semantic-rewrite content, gain-descending priority order,
and in-process CLI smoke tests (stdin, --file, empty input -> exit 2).
"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

from aop_optimizer import (
    SCHEMA_VERSION,
    AgentOptimizationEngine,
    build_directive_payload,
    parse_policy_semantics,
)
from aop_optimizer.__main__ import EXIT_OK, EXIT_USAGE, main

# The canonical demo policy from the component spec: business-day shipping,
# short window, restocking fee, store-credit-only refunds.
DEMO_POLICY = (
    "We charge a 15% restocking fee. Returns within 14 days for store "
    "credit only. Ships in 4-6 business days."
)


def _payload_for(text: str, **engine_kwargs):
    metrics = parse_policy_semantics(text)
    report = AgentOptimizationEngine(**engine_kwargs).evaluate(metrics)
    return build_directive_payload(metrics, report)


class PayloadSchemaTests(unittest.TestCase):
    def setUp(self):
        self.payload = _payload_for(DEMO_POLICY)

    def test_top_level_keys(self):
        self.assertEqual(
            set(self.payload.keys()),
            {
                "schema_version",
                "agent_match_score",
                "selection_probability",
                "extracted_metrics",
                "applied_deductions",
                "optimization_directives",
            },
        )
        self.assertEqual(self.payload["schema_version"], SCHEMA_VERSION)

    def test_extracted_metrics_shape(self):
        metrics = self.payload["extracted_metrics"]
        self.assertEqual(metrics["return_window_days"], 14)
        self.assertEqual(metrics["shipping_days"], 9)
        self.assertEqual(metrics["shipping_business_days"], 6)
        self.assertTrue(metrics["business_day_conversion_applied"])
        penalties = {p["code"] for p in metrics["hidden_penalties"]}
        self.assertEqual(penalties, {"restocking_fee", "store_credit_only"})

    def test_applied_deductions_shape(self):
        for deduction in self.payload["applied_deductions"]:
            self.assertEqual(set(deduction.keys()), {"code", "points", "detail"})
            self.assertGreater(deduction["points"], 0)
            self.assertTrue(deduction["detail"])

    def test_directive_shape(self):
        for directive in self.payload["optimization_directives"]:
            self.assertEqual(
                set(directive.keys()),
                {
                    "priority",
                    "code",
                    "field",
                    "detected",
                    "target",
                    "action",
                    "projected_score_gain",
                },
            )

    def test_payload_is_json_serializable(self):
        round_tripped = json.loads(json.dumps(self.payload))
        self.assertEqual(round_tripped["schema_version"], SCHEMA_VERSION)


class GainConsistencyTests(unittest.TestCase):
    """Every recoverable deduction maps into exactly one directive."""

    def _assert_gains_recover_score(self, text: str):
        payload = _payload_for(text)
        score = payload["agent_match_score"]
        self.assertGreater(score, 0.0, "test case must not clamp at the floor")
        gain_sum = sum(
            d["projected_score_gain"] for d in payload["optimization_directives"]
        )
        self.assertAlmostEqual(gain_sum, 100.0 - score, delta=0.01)

    def test_demo_policy(self):
        self._assert_gains_recover_score(DEMO_POLICY)

    def test_conditional_free_shipping_policy(self):
        self._assert_gains_recover_score(
            "Free shipping on orders over $50. Ships in 5 days. "
            "Returns within 22 days."
        )

    def test_ambiguous_policy(self):
        # Ambiguous shipping produces TWO deductions but ONE merged
        # directive; the merged gain must still recover both.
        self._assert_gains_recover_score("Great products, buy now!")

    def test_clean_policy_has_no_directives(self):
        payload = _payload_for(
            "Guaranteed delivery within 3 days. Free returns within 45 days "
            "of delivery. Free shipping on all orders."
        )
        self.assertEqual(payload["agent_match_score"], 100.0)
        self.assertEqual(payload["optimization_directives"], [])
        self.assertEqual(payload["applied_deductions"], [])


class DirectiveContentTests(unittest.TestCase):
    def setUp(self):
        self.payload = _payload_for(DEMO_POLICY)
        self.by_code = {
            d["code"]: d for d in self.payload["optimization_directives"]
        }

    def test_shipping_rewrite_is_exact(self):
        directive = self.by_code["REWRITE_SHIPPING_SLA"]
        self.assertEqual(directive["detected"], "Ships in 4-6 business days")
        self.assertEqual(
            directive["target"], "Guaranteed delivery within 3 days"
        )
        self.assertIn('"Ships in 4-6 business days"', directive["action"])
        self.assertIn('"Guaranteed delivery within 3 days."', directive["action"])
        self.assertEqual(directive["field"], "shipping_policy")
        # The rewrite recovers exactly the capped shipping deduction.
        ded = {d["code"]: d for d in self.payload["applied_deductions"]}
        self.assertEqual(
            directive["projected_score_gain"], ded["SHIP_OVERAGE"]["points"]
        )

    def test_return_window_rewrite(self):
        directive = self.by_code["EXTEND_RETURN_WINDOW"]
        self.assertIn("14 days", directive["detected"])
        self.assertEqual(
            directive["target"], "Free returns within 30 days of delivery"
        )
        self.assertEqual(directive["projected_score_gain"], 16.0)

    def test_hidden_term_rewrites_present(self):
        self.assertIn("REMOVE_RESTOCKING_FEE", self.by_code)
        self.assertIn("OFFER_ORIGINAL_PAYMENT_REFUNDS", self.by_code)
        restock = self.by_code["REMOVE_RESTOCKING_FEE"]
        self.assertIn("restocking fee", restock["detected"].lower())
        self.assertEqual(restock["target"], "No restocking fees")

    def test_sorted_by_gain_desc_with_priority_ranks(self):
        directives = self.payload["optimization_directives"]
        gains = [d["projected_score_gain"] for d in directives]
        self.assertEqual(gains, sorted(gains, reverse=True))
        self.assertEqual(
            [d["priority"] for d in directives],
            list(range(1, len(directives) + 1)),
        )
        # Highest-gain fix for the demo policy is the shipping rewrite.
        self.assertEqual(directives[0]["code"], "REWRITE_SHIPPING_SLA")

    def test_ambiguous_shipping_merges_into_one_directive(self):
        payload = _payload_for("Great products, buy now!")
        codes = [d["code"] for d in payload["optimization_directives"]]
        self.assertIn("DECLARE_SHIPPING_SLA", codes)
        self.assertNotIn("REWRITE_SHIPPING_SLA", codes)
        ded = {d["code"]: d for d in payload["applied_deductions"]}
        merged = next(
            d
            for d in payload["optimization_directives"]
            if d["code"] == "DECLARE_SHIPPING_SLA"
        )
        self.assertAlmostEqual(
            merged["projected_score_gain"],
            ded["SHIP_OVERAGE"]["points"] + ded["SHIP_AMBIGUOUS"]["points"],
            delta=0.001,
        )

    def test_final_sale_reversal_directive(self):
        payload = _payload_for("2-day shipping. All sales final.")
        codes = {d["code"] for d in payload["optimization_directives"]}
        self.assertIn("REVERSE_FINAL_SALE", codes)

    def test_malformed_inputs_degrade_without_raising(self):
        payload = build_directive_payload(None, None)
        self.assertEqual(payload["schema_version"], SCHEMA_VERSION)
        self.assertEqual(payload["optimization_directives"], [])


class CliSmokeTests(unittest.TestCase):
    """In-process CLI checks via main([...]) — no subprocesses needed."""

    def _run(self, argv, stdin_text=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        original_stdin = sys.stdin
        try:
            if stdin_text is not None:
                sys.stdin = io.StringIO(stdin_text)
            with redirect_stdout(stdout), redirect_stderr(stderr):
                code = main(argv)
        finally:
            sys.stdin = original_stdin
        return code, stdout.getvalue(), stderr.getvalue()

    def test_stdin_pretty_success(self):
        code, out, err = self._run(["--pretty"], stdin_text=DEMO_POLICY)
        self.assertEqual(code, EXIT_OK)
        payload = json.loads(out)
        self.assertEqual(payload["schema_version"], SCHEMA_VERSION)
        self.assertEqual(payload["agent_match_score"], 10.0)
        self.assertEqual(err, "")

    def test_empty_stdin_exits_2(self):
        code, out, err = self._run([], stdin_text="   \n  ")
        self.assertEqual(code, EXIT_USAGE)
        self.assertEqual(out, "")
        self.assertIn("empty policy text", err)

    def test_file_input(self):
        fd, path = tempfile.mkstemp(suffix=".txt")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write("30-day returns. 2-day shipping.")
            code, out, _ = self._run(["--file", path])
            self.assertEqual(code, EXIT_OK)
            payload = json.loads(out)
            self.assertEqual(
                payload["extracted_metrics"]["return_window_days"], 30
            )
        finally:
            os.unlink(path)

    def test_missing_file_exits_2(self):
        code, out, err = self._run(["--file", "/nonexistent/policy.txt"])
        self.assertEqual(code, EXIT_USAGE)
        self.assertEqual(out, "")
        self.assertIn("cannot read", err)

    def test_baseline_flag_changes_probability(self):
        _, out_default, _ = self._run([], stdin_text=DEMO_POLICY)
        _, out_low, _ = self._run(["--baseline", "5"], stdin_text=DEMO_POLICY)
        p_default = json.loads(out_default)["selection_probability"]
        p_low = json.loads(out_low)["selection_probability"]
        # Same score (10.0): above a baseline of 5 -> P > 0.5; far below the
        # default baseline of 62 -> tiny P.
        self.assertLess(p_default, 0.05)
        self.assertGreater(p_low, 0.5)

    def test_invalid_temperature_exits_2(self):
        code, out, err = self._run(
            ["--temperature", "0"], stdin_text=DEMO_POLICY
        )
        self.assertEqual(code, EXIT_USAGE)
        self.assertIn("--temperature", err)


if __name__ == "__main__":
    unittest.main()
