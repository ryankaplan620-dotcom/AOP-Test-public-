"""Tests for the Semantic Policy Rewriter (aop_optimizer.jsonld).

Covers: honest 'current' restatement (penalty mapping, final-sale,
unspecified), 'optimized' directive targets, the parser round-trip guarantee
for rewritten_policy_text, and dict-shaped metrics tolerance.
"""

import unittest

from aop_optimizer.jsonld import build_policy_jsonld, rewritten_policy_text
from aop_optimizer.scoring import AgentOptimizationEngine
from aop_optimizer.semantics import parse_policy_semantics


def _evaluate(text):
    metrics = parse_policy_semantics(text)
    report = AgentOptimizationEngine().evaluate(metrics)
    return metrics, report


class TestCurrentVariant(unittest.TestCase):
    def test_penalty_policy_maps_to_restocking_and_store_credit(self):
        metrics, report = _evaluate(
            "We charge a 15% restocking fee. Returns within 14 days for store "
            "credit only. Ships in 4-6 business days."
        )
        current = build_policy_jsonld(metrics, report)["current"]
        rp = current["returnPolicy"]
        self.assertEqual(rp["@type"], "MerchantReturnPolicy")
        self.assertEqual(rp["merchantReturnDays"], 14)
        self.assertIn("RestockingFees", rp["returnFees"])
        self.assertIn("StoreCreditRefund", rp["refundType"])
        # 6 business days -> 9 calendar days, honest maxValue
        transit = current["shipping"]["deliveryTime"]["transitTime"]
        self.assertEqual(transit["maxValue"], 9)
        self.assertEqual(transit["unitCode"], "DAY")

    def test_final_sale_maps_to_not_permitted(self):
        metrics, report = _evaluate("All sales final. Ships in 2 days.")
        rp = build_policy_jsonld(metrics, report)["current"]["returnPolicy"]
        self.assertIn("MerchantReturnNotPermitted", rp["returnPolicyCategory"])
        self.assertNotIn("merchantReturnDays", rp)

    def test_unspecified_returns_map_to_unspecified(self):
        metrics, report = _evaluate("Delivery within 2 days. Free shipping.")
        rp = build_policy_jsonld(metrics, report)["current"]["returnPolicy"]
        self.assertIn("MerchantReturnUnspecified", rp["returnPolicyCategory"])

    def test_clean_policy_maps_to_free_return_full_refund(self):
        metrics, report = _evaluate(
            "45-day returns, full refund. Free shipping on all orders. "
            "Delivery within 2 days."
        )
        current = build_policy_jsonld(metrics, report)["current"]
        rp = current["returnPolicy"]
        self.assertEqual(rp["merchantReturnDays"], 45)
        self.assertIn("FreeReturn", rp["returnFees"])
        self.assertIn("FullRefund", rp["refundType"])
        self.assertEqual(current["shipping"]["shippingRate"]["value"], 0)

    def test_ambiguous_shipping_is_flagged_as_assumed(self):
        metrics, report = _evaluate("30-day returns. We ship stuff eventually.")
        shipping = build_policy_jsonld(metrics, report)["current"]["shipping"]
        self.assertTrue(shipping.get("x-aop-assumed"))


class TestOptimizedVariant(unittest.TestCase):
    def test_targets_applied(self):
        metrics, report = _evaluate(
            "We charge a 15% restocking fee. Returns within 14 days for store "
            "credit only. Ships in 4-6 business days."
        )
        optimized = build_policy_jsonld(metrics, report)["optimized"]
        rp = optimized["returnPolicy"]
        self.assertEqual(rp["merchantReturnDays"], 30, "raised to target window")
        self.assertIn("FreeReturn", rp["returnFees"])
        self.assertIn("FullRefund", rp["refundType"])
        transit = optimized["shipping"]["deliveryTime"]["transitTime"]
        self.assertEqual(transit["maxValue"], 3, "bounded to target shipping days")
        self.assertEqual(optimized["shipping"]["shippingRate"]["value"], 0)

    def test_generous_existing_window_is_kept(self):
        metrics, report = _evaluate("60-day returns. 2-day shipping.")
        rp = build_policy_jsonld(metrics, report)["optimized"]["returnPolicy"]
        self.assertEqual(rp["merchantReturnDays"], 60, "never shrink a better window")


class TestRewrittenTextRoundTrip(unittest.TestCase):
    def test_optimized_prose_parses_to_a_perfect_score(self):
        # The rewriter's whole promise: its output is agent-parseable. Feed
        # the rewritten text back through our own parser + engine — it must
        # extract the target terms and score a clean 100.
        metrics, report = _evaluate(
            "We charge a 15% restocking fee. Returns within 14 days for store "
            "credit only. Ships in 4-6 business days."
        )
        text = rewritten_policy_text(metrics, report)
        metrics2 = parse_policy_semantics(text)
        report2 = AgentOptimizationEngine().evaluate(metrics2)
        self.assertEqual(report2.agent_match_score, 100.0, f"round-trip failed for: {text!r}")
        self.assertEqual(metrics2.hidden_penalties, [])
        self.assertFalse(metrics2.ambiguous_shipping)


class TestDefensiveShapes(unittest.TestCase):
    def test_dict_shaped_metrics_are_tolerated(self):
        # Metrics may arrive as a JSON round-trip (plain dicts) from the
        # HTTP seam; the builder must not require dataclass instances.
        metrics = {
            "return_window_days": 14,
            "final_sale": False,
            "returns_unspecified": False,
            "shipping_days": 9,
            "ambiguous_shipping": False,
            "free_shipping": False,
            "free_shipping_conditional": False,
            "hidden_penalties": [{"code": "restocking_fee", "evidence": "x"}],
        }
        report = AgentOptimizationEngine().evaluate(parse_policy_semantics("14-day returns"))
        artifact = build_policy_jsonld(metrics, report)
        self.assertIn("RestockingFees", artifact["current"]["returnPolicy"]["returnFees"])
        self.assertEqual(artifact["optimized"]["returnPolicy"]["merchantReturnDays"], 30)


if __name__ == "__main__":
    unittest.main()
