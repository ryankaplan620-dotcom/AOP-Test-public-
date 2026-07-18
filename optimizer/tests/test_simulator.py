"""Tests for the Pricing & Policy What-If Simulator (aop_optimizer.simulator)."""

import unittest

from aop_optimizer.scoring import AgentOptimizationEngine
from aop_optimizer.semantics import parse_policy_semantics
from aop_optimizer.simulator import simulate_variations

PENALTY_POLICY = (
    "We charge a 15% restocking fee. Returns within 14 days for store credit "
    "only. Ships in 4-6 business days."
)


def _simulate(text, **engine_kwargs):
    metrics = parse_policy_semantics(text)
    engine = AgentOptimizationEngine(**engine_kwargs)
    return simulate_variations(metrics, engine), metrics


class TestScenarioCatalog(unittest.TestCase):
    def test_penalty_policy_generates_expected_scenarios(self):
        result, _ = _simulate(PENALTY_POLICY)
        codes = {s["code"] for s in result["scenarios"]}
        # Return rungs above the current 14-day window.
        self.assertIn("EXTEND_RETURNS_30", codes)
        self.assertIn("EXTEND_RETURNS_60", codes)
        # Faster-than-9-calendar-days shipping commitments.
        self.assertIn("GUARANTEE_SHIPPING_3", codes)
        self.assertIn("GUARANTEE_SHIPPING_2", codes)
        # One removal scenario per detected penalty clause.
        self.assertIn("REMOVE_RESTOCKING_FEE", codes)
        self.assertIn("REMOVE_STORE_CREDIT_ONLY", codes)
        # No free-shipping mention -> the unconditional-free-shipping lever.
        self.assertIn("FREE_SHIPPING", codes)
        self.assertIn("FULLY_OPTIMIZED", codes)

    def test_clean_policy_generates_no_redundant_levers(self):
        result, _ = _simulate(
            "60-day returns, full refund. Guaranteed delivery within 2 days. "
            "Free shipping on all orders."
        )
        codes = {s["code"] for s in result["scenarios"]}
        # Nothing to extend/speed up/remove: only the ceiling remains.
        self.assertEqual(codes, {"FULLY_OPTIMIZED"})
        self.assertEqual(result["baseline"]["agent_match_score"], 100.0)

    def test_ceiling_is_pinned_last_and_dominates(self):
        result, _ = _simulate(PENALTY_POLICY)
        scenarios = result["scenarios"]
        self.assertEqual(scenarios[-1]["code"], "FULLY_OPTIMIZED")
        best_single = max(s["score_delta"] for s in scenarios[:-1])
        self.assertGreaterEqual(scenarios[-1]["score_delta"], best_single)
        # For a policy whose every deduction is recoverable, the ceiling is 100.
        self.assertEqual(scenarios[-1]["agent_match_score"], 100.0)


class TestDeltas(unittest.TestCase):
    def test_every_scenario_improves_or_holds_the_score(self):
        # Each catalog entry is an improvement lever; none may LOWER the score.
        result, _ = _simulate(PENALTY_POLICY)
        for scenario in result["scenarios"]:
            self.assertGreaterEqual(
                scenario["score_delta"], 0, f"{scenario['code']} lowered the score"
            )

    def test_deltas_are_consistent_with_absolute_values(self):
        result, _ = _simulate(PENALTY_POLICY)
        base = result["baseline"]
        for scenario in result["scenarios"]:
            self.assertAlmostEqual(
                scenario["score_delta"],
                scenario["agent_match_score"] - base["agent_match_score"],
                places=6,
            )
            self.assertAlmostEqual(
                scenario["probability_delta"],
                scenario["selection_probability"] - base["selection_probability"],
                places=6,
            )

    def test_probability_moves_with_score(self):
        # Monotonicity through the logistic: higher score -> higher probability.
        result, _ = _simulate(PENALTY_POLICY)
        for scenario in result["scenarios"]:
            if scenario["score_delta"] > 0:
                self.assertGreater(scenario["probability_delta"], 0, scenario["code"])

    def test_engine_config_carries_into_simulation(self):
        # With the market baseline at the ceiling score, even FULLY_OPTIMIZED
        # lands at probability 0.5 — proof the same engine config is reused.
        result, _ = _simulate(PENALTY_POLICY, market_baseline_score=100.0)
        ceiling = result["scenarios"][-1]
        self.assertEqual(ceiling["agent_match_score"], 100.0)
        self.assertAlmostEqual(ceiling["selection_probability"], 0.5, places=6)


class TestVariationSemantics(unittest.TestCase):
    def test_extend_returns_never_offered_below_current_window(self):
        result, _ = _simulate("45-day returns. Ships in 5 days.")
        codes = {s["code"] for s in result["scenarios"]}
        self.assertNotIn("EXTEND_RETURNS_30", codes, "30 < current 45 — not an improvement")
        self.assertIn("EXTEND_RETURNS_60", codes)

    def test_unspecified_returns_offer_all_rungs(self):
        result, metrics = _simulate("Ships in 2 days. Free shipping on all orders.")
        self.assertTrue(metrics.returns_unspecified)
        codes = {s["code"] for s in result["scenarios"]}
        for days in (30, 45, 60):
            self.assertIn(f"EXTEND_RETURNS_{days}", codes)

    def test_input_metrics_are_never_mutated(self):
        metrics = parse_policy_semantics(PENALTY_POLICY)
        before = (
            metrics.return_window_days,
            metrics.shipping_days,
            tuple(t.code for t in metrics.hidden_penalties),
        )
        simulate_variations(metrics, AgentOptimizationEngine())
        after = (
            metrics.return_window_days,
            metrics.shipping_days,
            tuple(t.code for t in metrics.hidden_penalties),
        )
        self.assertEqual(before, after, "simulator must work on copies")


if __name__ == "__main__":
    unittest.main()
