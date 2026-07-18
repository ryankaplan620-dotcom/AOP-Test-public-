"""simulator.py — the Pricing & Policy What-If Simulator.

Role in the AOP data flow:
    parse_policy_semantics() -> PolicyMetrics -> THIS MODULE (counterfactual
    metric variations) -> AgentOptimizationEngine.evaluate() per variation ->
    the dashboard's "What-If Simulator" table.

Product feature (spec, "Agent Competitive Intelligence"): merchants run
what-if models to see how extending a return window, guaranteeing faster
shipping, or dropping a penalty clause changes their probability of being
selected by shopping agents — BEFORE changing real operations.

Design: a simulation never re-parses text. It clones the parsed
``PolicyMetrics`` with one (or all) counterfactual change(s) applied via
``dataclasses.replace`` and re-runs the SAME scoring engine, so what-if
numbers are exactly comparable to the baseline — same weights, same
baseline/temperature configuration.

Scenario catalog (generated only when applicable to the input policy):
    EXTEND_RETURNS_<n>     raise the return window to n days (30/45/60)
    GUARANTEE_SHIPPING_<n> commit to n-day delivery (target and express)
    REMOVE_<PENALTY>       drop one detected hidden-penalty clause
    FREE_SHIPPING          make shipping unconditionally free
    FULLY_OPTIMIZED        all of the above at once (the ceiling)

Stdlib only. Pure: no I/O, deterministic for a given input.
"""

from dataclasses import replace
from typing import Any, Dict, List

from .scoring import AgentOptimizationEngine
from .semantics import PolicyMetrics

#: Return-window rungs offered as counterfactuals (days).
RETURN_WINDOW_RUNGS = (30, 45, 60)

#: Shipping-commitment rungs (days). 3 = the agent-tolerance target; 2 = an
#: express commitment that beats the target.
SHIPPING_RUNGS = (3, 2)

#: Human labels for hidden-penalty removal scenarios.
_PENALTY_LABELS = {
    "restocking_fee": "Eliminate the restocking fee",
    "store_credit_only": "Refund to original payment (not store credit)",
    "exchange_only": "Allow refunds, not exchange-only",
    "customer_pays_return_shipping": "Offer free return shipping",
    "final_sale": "Remove final-sale / non-returnable carve-outs",
    "warranty_void": "Remove warranty-void clauses",
}


def _returns_variation(metrics: PolicyMetrics, days: int) -> PolicyMetrics:
    """Counterfactual: the store commits to a `days`-day full return window."""
    return replace(
        metrics,
        return_window_days=days,
        final_sale=False,
        returns_unspecified=False,
    )


def _shipping_variation(metrics: PolicyMetrics, days: int) -> PolicyMetrics:
    """Counterfactual: the store guarantees delivery within `days` calendar days."""
    return replace(
        metrics,
        shipping_days=days,
        shipping_business_days=None,
        business_day_conversion_applied=False,
        ambiguous_shipping=False,
    )


def _remove_penalty_variation(metrics: PolicyMetrics, code: str) -> PolicyMetrics:
    """Counterfactual: one hidden-penalty clause is removed from the policy."""
    remaining = [term for term in metrics.hidden_penalties if term.code != code]
    changed = replace(metrics, hidden_penalties=remaining)
    if code == "final_sale":
        changed = replace(changed, final_sale=False)
    return changed


def _free_shipping_variation(metrics: PolicyMetrics) -> PolicyMetrics:
    """Counterfactual: shipping becomes unconditionally free."""
    return replace(
        metrics,
        free_shipping=True,
        free_shipping_conditional=False,
        free_shipping_threshold=None,
    )


def _evaluate(engine: AgentOptimizationEngine, metrics: PolicyMetrics) -> Dict[str, Any]:
    report = engine.evaluate(metrics)
    return {
        "agent_match_score": report.agent_match_score,
        "selection_probability": report.selection_probability,
    }


def simulate_variations(metrics: PolicyMetrics, engine: AgentOptimizationEngine) -> Dict[str, Any]:
    """Run the what-if catalog against a parsed policy.

    @param metrics  the baseline ``PolicyMetrics`` (from parse_policy_semantics).
    @param engine   the configured scoring engine — the SAME instance/config
                    used for the baseline, so deltas are apples-to-apples.
    @returns {"baseline": {...}, "scenarios": [...]} where each scenario is
        {code, description, changes: [str], agent_match_score,
         selection_probability, score_delta, probability_delta}, sorted by
        score_delta descending (biggest single lever first, FULLY_OPTIMIZED
        pinned last as the ceiling summary).
    """
    baseline = _evaluate(engine, metrics)
    scenarios: List[Dict[str, Any]] = []

    def add(code: str, description: str, changes: List[str], varied: PolicyMetrics) -> None:
        result = _evaluate(engine, varied)
        scenarios.append(
            {
                "code": code,
                "description": description,
                "changes": changes,
                "agent_match_score": result["agent_match_score"],
                "selection_probability": result["selection_probability"],
                # Score deltas round cleanly (engine scores are 0.1-grain);
                # probability deltas keep 6dp to match the engine's output.
                "score_delta": round(result["agent_match_score"] - baseline["agent_match_score"], 2),
                "probability_delta": round(
                    result["selection_probability"] - baseline["selection_probability"], 6
                ),
            }
        )

    # --- return-window rungs (only ones that IMPROVE on the current window) --
    current_window = metrics.return_window_days or 0
    for days in RETURN_WINDOW_RUNGS:
        if days > current_window or metrics.returns_unspecified or metrics.final_sale:
            add(
                f"EXTEND_RETURNS_{days}",
                f"Extend the return window to {days} days (full refund)",
                [f"return_window_days -> {days}"],
                _returns_variation(metrics, days),
            )

    # --- shipping rungs (only when faster than the current commitment) ------
    for days in SHIPPING_RUNGS:
        if metrics.ambiguous_shipping or days < metrics.shipping_days:
            add(
                f"GUARANTEE_SHIPPING_{days}",
                f"Guarantee delivery within {days} days",
                [f"shipping_days -> {days}", "ambiguous_shipping -> false"],
                _shipping_variation(metrics, days),
            )

    # --- hidden-penalty removals (one scenario per detected clause) ---------
    for term in metrics.hidden_penalties:
        label = _PENALTY_LABELS.get(term.code, f"Remove the '{term.code}' clause")
        add(
            f"REMOVE_{term.code.upper()}",
            label,
            [f"hidden_penalties -= {term.code}"],
            _remove_penalty_variation(metrics, term.code),
        )

    # --- unconditional free shipping ----------------------------------------
    if not metrics.free_shipping or metrics.free_shipping_conditional:
        add(
            "FREE_SHIPPING",
            "Offer unconditional free shipping",
            ["free_shipping -> true (unconditional)"],
            _free_shipping_variation(metrics),
        )

    # --- the ceiling: everything at once ------------------------------------
    combined = metrics
    combined = _returns_variation(combined, max(RETURN_WINDOW_RUNGS[0], current_window))
    combined = _shipping_variation(combined, min(SHIPPING_RUNGS))
    for term in list(combined.hidden_penalties):
        combined = _remove_penalty_variation(combined, term.code)
    combined = _free_shipping_variation(combined)
    add(
        "FULLY_OPTIMIZED",
        "Apply every optimization at once (ceiling)",
        ["all of the above"],
        combined,
    )

    # Biggest single lever first; the ceiling summary pinned last.
    ceiling = scenarios.pop()
    scenarios.sort(key=lambda s: s["score_delta"], reverse=True)
    scenarios.append(ceiling)

    return {"baseline": baseline, "scenarios": scenarios}
