"""
AOP :: optimizer/tests/test_scoring.py
======================================

Unit tests for the AgentOptimizationEngine (scoring.py) — the deduction
model and the logistic selection-probability curve.  Covers the score
edges (a clean policy scores exactly 100, a pathological one floors at 0),
every deduction family's weighting, probability monotonicity, and the
baseline -> 0.5 coin-flip behavior.
"""

import math
import unittest

from aop_optimizer.scoring import AgentOptimizationEngine, ScoreReport
from aop_optimizer.semantics import PolicyMetrics, parse_policy_semantics

# A policy with zero defects under the default baselines: 3-day shipping,
# 45-day returns, unconditional free shipping, no hidden terms.
CLEAN_POLICY = (
    "Guaranteed delivery within 3 days. Free returns within 45 days of "
    "delivery. Free shipping on all orders."
)

# A policy hitting every deduction family at once — total raw deductions
# far exceed 100, so the score must clamp at the 0 floor.
PATHOLOGICAL_POLICY = (
    "All sales final. 20% restocking fee. Store credit only. Exchanges "
    "only. Customer pays return shipping. Opening the box voids your "
    "warranty. Clearance items are final sale. Free shipping on orders "
    "over $999."
)


def _codes(report: ScoreReport):
    return {d.code: d for d in report.deductions}


class ScoreEdgeTests(unittest.TestCase):
    def setUp(self):
        self.engine = AgentOptimizationEngine()

    def test_clean_policy_scores_100_with_no_deductions(self):
        report = self.engine.evaluate(parse_policy_semantics(CLEAN_POLICY))
        self.assertEqual(report.agent_match_score, 100.0)
        self.assertEqual(report.deductions, [])

    def test_pathological_policy_floors_at_zero(self):
        report = self.engine.evaluate(parse_policy_semantics(PATHOLOGICAL_POLICY))
        self.assertEqual(report.agent_match_score, 0.0)
        # The clamp must not hide the individual deductions.
        self.assertGreater(sum(d.points for d in report.deductions), 100.0)

    def test_score_never_exceeds_100(self):
        # Unconditional free shipping is the absence of penalty, never a
        # bonus: even a maximally generous policy caps at exactly 100.
        report = self.engine.evaluate(
            parse_policy_semantics(
                "Same-day delivery. 365 days to return. Free shipping on all "
                "orders. Free prepaid return labels."
            )
        )
        self.assertEqual(report.agent_match_score, 100.0)


class ShippingDeductionTests(unittest.TestCase):
    def setUp(self):
        self.engine = AgentOptimizationEngine()

    def test_overage_is_15_points_per_day(self):
        # 5 calendar days = 2 over the 3-day target -> 30 points.
        report = self.engine.evaluate(
            parse_policy_semantics("Ships in 5 days. Returns within 45 days.")
        )
        ded = _codes(report)
        self.assertEqual(ded["SHIP_OVERAGE"].points, 30.0)

    def test_overage_capped_at_45(self):
        metrics = PolicyMetrics(
            shipping_days=30,
            ambiguous_shipping=False,
            return_window_days=45,
        )
        ded = _codes(self.engine.evaluate(metrics))
        self.assertEqual(ded["SHIP_OVERAGE"].points, 45.0)

    def test_business_day_conversion_reflected_in_detail(self):
        report = self.engine.evaluate(
            parse_policy_semantics("Ships in 4-6 business days. Returns within 45 days.")
        )
        ded = _codes(report)
        # 6 business -> 9 calendar -> 6 over target -> 90 -> capped at 45.
        self.assertEqual(ded["SHIP_OVERAGE"].points, 45.0)
        self.assertIn("business", ded["SHIP_OVERAGE"].detail)

    def test_ambiguous_shipping_penalized_on_top_of_assumed_default(self):
        report = self.engine.evaluate(parse_policy_semantics("hello world"))
        ded = _codes(report)
        # Assumed 7-day default -> 4 over target -> 60 -> capped 45; plus
        # the flat 10-point ambiguity penalty; plus unspecified returns.
        self.assertEqual(ded["SHIP_AMBIGUOUS"].points, 10.0)
        self.assertEqual(ded["SHIP_OVERAGE"].points, 45.0)
        self.assertEqual(ded["RETURN_UNSPECIFIED"].points, 18.0)
        self.assertEqual(report.agent_match_score, 27.0)

    def test_no_overage_at_or_under_target(self):
        report = self.engine.evaluate(
            parse_policy_semantics("2-day shipping. Returns within 45 days.")
        )
        self.assertNotIn("SHIP_OVERAGE", _codes(report))


class ReturnDeductionTests(unittest.TestCase):
    def setUp(self):
        self.engine = AgentOptimizationEngine()

    def test_short_window_scales_with_shortfall(self):
        # 25-day window = 5 short of the 30-day target -> 5 points.
        report = self.engine.evaluate(
            parse_policy_semantics("2-day shipping. Returns within 25 days.")
        )
        ded = _codes(report)
        self.assertEqual(ded["RETURN_SHORT"].points, 5.0)

    def test_final_sale_is_full_shortfall(self):
        report = self.engine.evaluate(
            parse_policy_semantics("2-day shipping. All sales final.")
        )
        ded = _codes(report)
        self.assertEqual(ded["RETURN_SHORT"].points, 30.0)
        self.assertIn("no-returns", ded["RETURN_SHORT"].detail)

    def test_unspecified_penalized_differently_from_short(self):
        unspec = self.engine.evaluate(parse_policy_semantics("2-day shipping."))
        short = self.engine.evaluate(
            parse_policy_semantics("2-day shipping. Returns within 25 days.")
        )
        unspec_ded = _codes(unspec)
        short_ded = _codes(short)
        self.assertIn("RETURN_UNSPECIFIED", unspec_ded)
        self.assertNotIn("RETURN_SHORT", unspec_ded)
        self.assertIn("RETURN_SHORT", short_ded)
        self.assertNotIn("RETURN_UNSPECIFIED", short_ded)
        # Flat 18 for silence vs shortfall-scaled for a stated window.
        self.assertEqual(unspec_ded["RETURN_UNSPECIFIED"].points, 18.0)
        self.assertNotEqual(
            unspec_ded["RETURN_UNSPECIFIED"].points, short_ded["RETURN_SHORT"].points
        )

    def test_window_at_target_is_clean(self):
        report = self.engine.evaluate(
            parse_policy_semantics("2-day shipping. Returns within 30 days.")
        )
        ded = _codes(report)
        self.assertNotIn("RETURN_SHORT", ded)
        self.assertNotIn("RETURN_UNSPECIFIED", ded)


class HiddenPenaltyDeductionTests(unittest.TestCase):
    def setUp(self):
        self.engine = AgentOptimizationEngine()

    def _single_penalty_points(self, text: str, code: str) -> float:
        report = self.engine.evaluate(parse_policy_semantics(text))
        return _codes(report)[code].points

    def test_restocking_fee_scales_with_percent(self):
        # base 5 + 0.6 * 15 = 14.
        self.assertEqual(
            self._single_penalty_points(
                "15% restocking fee. 2-day shipping. Returns within 30 days.",
                "RESTOCKING_FEE",
            ),
            14.0,
        )

    def test_restocking_fee_percent_capped(self):
        # base 5 + 0.6 * 50 = 35 -> capped at 25.
        self.assertEqual(
            self._single_penalty_points(
                "50% restocking fee. 2-day shipping. Returns within 30 days.",
                "RESTOCKING_FEE",
            ),
            25.0,
        )

    def test_restocking_fee_scales_with_dollars(self):
        # base 5 + 0.4 * 10 = 9.
        self.assertEqual(
            self._single_penalty_points(
                "A $10 restocking fee applies. 2-day shipping. Returns within 30 days.",
                "RESTOCKING_FEE",
            ),
            9.0,
        )

    def test_restocking_fee_unknown_size_flat(self):
        self.assertEqual(
            self._single_penalty_points(
                "A restocking fee may apply. 2-day shipping. Returns within 30 days.",
                "RESTOCKING_FEE",
            ),
            10.0,
        )

    def test_flat_hidden_term_weights(self):
        cases = [
            ("Refunds for store credit only.", "STORE_CREDIT_ONLY", 15.0),
            ("Exchanges only, no cash refunds.", "EXCHANGE_ONLY", 18.0),
            ("Customer pays return shipping.", "CUSTOMER_PAYS_RETURN_SHIPPING", 8.0),
            ("Clearance items are final sale.", "FINAL_SALE_CATEGORY", 10.0),
            ("Tampering voids the warranty.", "WARRANTY_VOID", 12.0),
        ]
        base = "2-day shipping. Returns within 30 days. "
        for clause, code, expected in cases:
            with self.subTest(code=code):
                self.assertEqual(
                    self._single_penalty_points(base + clause, code), expected
                )
        # Every deduction carries evidence in its human detail.
        report = self.engine.evaluate(
            parse_policy_semantics(base + "Customer pays return shipping.")
        )
        detail = _codes(report)["CUSTOMER_PAYS_RETURN_SHIPPING"].detail
        self.assertIn("Customer pays return shipping", detail)


class FreeShippingDeductionTests(unittest.TestCase):
    def setUp(self):
        self.engine = AgentOptimizationEngine()

    def test_conditional_minor_penalty(self):
        report = self.engine.evaluate(
            parse_policy_semantics(
                "2-day shipping. Returns within 30 days. "
                "Free shipping on orders over $50."
            )
        )
        ded = _codes(report)
        self.assertEqual(ded["FREE_SHIPPING_CONDITIONAL"].points, 4.0)
        self.assertIn("$50", ded["FREE_SHIPPING_CONDITIONAL"].detail)

    def test_unconditional_is_absence_of_penalty_not_bonus(self):
        with_free = self.engine.evaluate(
            parse_policy_semantics(
                "2-day shipping. Returns within 30 days. Free shipping on all orders."
            )
        )
        without_free = self.engine.evaluate(
            parse_policy_semantics("2-day shipping. Returns within 30 days.")
        )
        self.assertEqual(with_free.agent_match_score, 100.0)
        self.assertEqual(without_free.agent_match_score, 100.0)
        self.assertNotIn("FREE_SHIPPING_CONDITIONAL", _codes(with_free))


class SelectionProbabilityTests(unittest.TestCase):
    def setUp(self):
        self.engine = AgentOptimizationEngine()

    def test_score_at_baseline_is_coin_flip(self):
        self.assertAlmostEqual(self.engine.selection_probability(62.0), 0.5, places=12)

    def test_evaluate_at_baseline_reports_half(self):
        # 5-day shipping (30 pts) + 22-day returns (8 pts) = 38 deducted ->
        # score 62 == default baseline -> P must be exactly 0.5.
        report = self.engine.evaluate(
            parse_policy_semantics("Ships in 5 days. Returns within 22 days.")
        )
        self.assertEqual(report.agent_match_score, 62.0)
        self.assertAlmostEqual(report.selection_probability, 0.5, places=6)

    def test_logistic_formula(self):
        for score in (0.0, 10.0, 50.0, 62.0, 80.0, 100.0):
            expected = 1.0 / (1.0 + math.exp(-(score - 62.0) / 12.0))
            self.assertAlmostEqual(
                self.engine.selection_probability(score), expected, places=12
            )

    def test_monotonically_increasing_in_score(self):
        probs = [self.engine.selection_probability(s) for s in range(0, 101, 5)]
        for lower, higher in zip(probs, probs[1:]):
            self.assertLess(lower, higher)

    def test_probability_is_relative_not_score_over_100(self):
        # The whole point of the logistic: a mid-pack absolute score sits
        # near the coin flip, NOT near score/100.
        p = self.engine.selection_probability(62.0)
        self.assertNotAlmostEqual(p, 0.62, places=2)
        self.assertAlmostEqual(p, 0.5, places=12)

    def test_custom_baseline_moves_the_midpoint(self):
        engine = AgentOptimizationEngine(market_baseline_score=50.0)
        self.assertAlmostEqual(engine.selection_probability(50.0), 0.5, places=12)

    def test_temperature_controls_steepness(self):
        sharp = AgentOptimizationEngine(probability_temperature=4.0)
        soft = AgentOptimizationEngine(probability_temperature=24.0)
        # Ten points above baseline: the sharp curve is far more confident.
        self.assertGreater(
            sharp.selection_probability(72.0), soft.selection_probability(72.0)
        )

    def test_extreme_scores_saturate_without_overflow(self):
        self.assertEqual(self.engine.selection_probability(1e9), 1.0)
        self.assertEqual(self.engine.selection_probability(-1e9), 0.0)


class ConfigurationAndRobustnessTests(unittest.TestCase):
    def test_custom_shipping_target(self):
        engine = AgentOptimizationEngine(target_max_shipping_days=5)
        report = engine.evaluate(
            parse_policy_semantics("Ships in 5 days. Returns within 45 days.")
        )
        self.assertNotIn("SHIP_OVERAGE", _codes(report))

    def test_custom_return_target(self):
        engine = AgentOptimizationEngine(target_min_return_window=14)
        report = engine.evaluate(
            parse_policy_semantics("2-day shipping. Returns within 14 days.")
        )
        self.assertNotIn("RETURN_SHORT", _codes(report))

    def test_invalid_temperature_falls_back_to_default(self):
        self.assertEqual(
            AgentOptimizationEngine(probability_temperature=0).probability_temperature,
            12.0,
        )
        self.assertEqual(
            AgentOptimizationEngine(
                probability_temperature=float("nan")
            ).probability_temperature,
            12.0,
        )

    def test_invalid_baseline_falls_back_to_default(self):
        self.assertEqual(
            AgentOptimizationEngine(
                market_baseline_score="not-a-number"
            ).market_baseline_score,
            62.0,
        )

    def test_evaluate_never_raises_on_malformed_metrics(self):
        engine = AgentOptimizationEngine()
        for junk in (None, "text", 42, {"shipping_days": 3}):
            with self.subTest(junk=junk):
                report = engine.evaluate(junk)
                self.assertIsInstance(report, ScoreReport)
                # Malformed input scores as a fully opaque policy.
                codes = _codes(report)
                self.assertIn("RETURN_UNSPECIFIED", codes)
                self.assertIn("SHIP_AMBIGUOUS", codes)


if __name__ == "__main__":
    unittest.main()
