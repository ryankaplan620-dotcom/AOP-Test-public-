"""
AOP :: optimizer/aop_optimizer/__init__.py
==========================================

Role in the AOP data flow
-------------------------
Public API surface of the Agent Optimization (policy scoring) engine — the
offline analytics component of the Agent Optimization Platform.  While the
Cloudflare Worker edge proxy handles live agent traffic and the ingestion
service stitches attribution, THIS package answers the follow-up question
surfaced by `loss_diagnostics`: "why do agents rank this merchant down, and
what exact policy text should change?"

Pipeline:  raw policy text
             -> parse_policy_semantics()   (semantics.py, regex extraction)
             -> AgentOptimizationEngine.evaluate()  (scoring.py, 0-100 score
                + logistic selection probability)
             -> build_directive_payload()  (directives.py, machine-actionable
                JSON with exact semantic rewrites)

Everything is stdlib-only and guaranteed non-raising on arbitrary input —
an analytics failure must never break the merchant's live traffic.

Usage
-----
    from aop_optimizer import (
        AgentOptimizationEngine,
        build_directive_payload,
        parse_policy_semantics,
    )

    metrics = parse_policy_semantics(policy_text)
    report = AgentOptimizationEngine().evaluate(metrics)
    payload = build_directive_payload(metrics, report)

Or from the command line:  python3 -m aop_optimizer --file policy.txt --pretty
"""

from .directives import SCHEMA_VERSION, build_directive_payload
from .scoring import AgentOptimizationEngine, Deduction, ScoreReport
from .simulator import simulate_variations
from .semantics import (
    DEFAULT_SHIPPING_DAYS,
    HiddenPenaltyTerm,
    PolicyMetrics,
    parse_policy_semantics,
)

#: Package version — kept in lockstep with the payload SCHEMA_VERSION while
#: both are 1.x; they may diverge once the payload contract stabilizes.
__version__ = "1.0.0"

__all__ = [
    "AgentOptimizationEngine",
    "Deduction",
    "DEFAULT_SHIPPING_DAYS",
    "HiddenPenaltyTerm",
    "PolicyMetrics",
    "SCHEMA_VERSION",
    "ScoreReport",
    "build_directive_payload",
    "parse_policy_semantics",
    "simulate_variations",
    "__version__",
]
