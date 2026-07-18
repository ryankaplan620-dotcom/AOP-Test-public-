"""
AOP :: optimizer/aop_optimizer/scoring.py
=========================================

Role in the AOP data flow
-------------------------
Second stage of the offline policy-scoring pipeline.  `semantics.py` turns
raw merchant policy text into a `PolicyMetrics` fact sheet; this module's
`AgentOptimizationEngine` turns that fact sheet into:

  * an absolute Agent Match Score (0-100) — how attractive the policy is to
    an LLM shopping agent evaluating the merchant, and
  * a Selection Probability — the modeled chance an agent *picks* this
    merchant over the category field.

The output `ScoreReport` feeds `directives.build_directive_payload`, which
the AOP dashboard serves to merchants alongside `loss_diagnostics` rows so
they can see WHY agents drop off and exactly what text to change.

Scoring model (deductions from a perfect 100)
---------------------------------------------
code                          weight
SHIP_OVERAGE                  15 pts per calendar day over the shipping
                              target (default 3), capped at 45 — beyond
                              three days over target agents have already
                              deprioritized the merchant, so deeper slowness
                              adds no additional discrimination.
SHIP_AMBIGUOUS                flat 10 — unparseable speed.  Applied ON TOP
                              of the overage computed from the assumed
                              7-day default: the agent both assumes the
                              median AND distrusts the ambiguity.
RETURN_SHORT                  1 pt per day the window falls short of the
                              return target (default 30).  A store-wide
                              final-sale policy is window 0 -> full 30 pts.
RETURN_UNSPECIFIED            flat 18 — silence is penalized differently
                              from a short-but-stated window: agents treat
                              missing terms as risk, but less harshly than
                              an explicit refusal (final sale -> 30).
RESTOCKING_FEE                5 base + 0.6/percent-point or 0.4/dollar,
                              capped at 25 (scales with the captured fee).
STORE_CREDIT_ONLY             flat 15 — refund value trapped with merchant.
EXCHANGE_ONLY                 flat 18 — no cash remedy at all.
CUSTOMER_PAYS_RETURN_SHIPPING flat 8.
FINAL_SALE_CATEGORY           flat 10 — category carve-outs from returns.
WARRANTY_VOID                 flat 12.
FREE_SHIPPING_CONDITIONAL     flat 4 — threshold-gated "free*" shipping
                              misleads agent price comparison.
(unconditional free shipping) NO deduction — it is the absence of penalty,
                              never a bonus: the score is capped at 100.

Selection probability
---------------------
    P(selected) = 1 / (1 + exp(-(score - market_baseline_score)
                                 / probability_temperature))

This is a logistic curve against a configurable market baseline (default
62), NOT score/100.  Rationale: shopping agents do not award business in
proportion to absolute quality — they pick winners RELATIVE to the category
field.  A merchant scoring exactly at the market baseline is a coin flip
(P=0.5); scores meaningfully above the field saturate toward certainty and
scores below it collapse toward zero.  Mid-pack absolute scores therefore
collapse toward 0.5 instead of the misleading 0.62 that score/100 would
report.  `probability_temperature` (default 12) controls how sharply the
curve saturates.

Operational constraint: `evaluate` never raises — a scoring failure inside
AOP analytics must never cascade into anything user-facing.

Stdlib only (math, dataclasses, typing).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, List, Optional

from .semantics import DEFAULT_SHIPPING_DAYS, PolicyMetrics

# ---------------------------------------------------------------------------
# Report dataclasses
# ---------------------------------------------------------------------------


@dataclass
class Deduction:
    """One applied scoring deduction: machine code + points + human detail."""

    code: str
    points: float
    detail: str


@dataclass
class ScoreReport:
    """Full evaluation result, including the config echo that produced it.

    The config echo (targets/baseline/temperature) is carried so that
    `directives.build_directive_payload` can phrase rewrite targets and so
    stored reports remain interpretable after engine defaults change.
    """

    agent_match_score: float
    selection_probability: float
    deductions: List[Deduction] = field(default_factory=list)
    target_max_shipping_days: int = 3
    target_min_return_window: int = 30
    market_baseline_score: float = 62.0
    probability_temperature: float = 12.0


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class AgentOptimizationEngine:
    """Scores PolicyMetrics the way an LLM shopping agent ranks merchants.

    All baselines are configurable per-merchant-category via the
    constructor; the deduction weights are class constants (documented in
    the module docstring) so the scoring model is versioned with the code,
    not with per-call configuration.
    """

    # --- deduction weights (see module docstring for rationale) ---------
    SHIPPING_OVERAGE_POINTS_PER_DAY = 15.0
    SHIPPING_OVERAGE_CAP = 45.0
    AMBIGUOUS_SHIPPING_PENALTY = 10.0
    RETURN_SHORTFALL_POINTS_PER_DAY = 1.0
    UNSPECIFIED_RETURNS_PENALTY = 18.0
    RESTOCKING_FEE_BASE = 5.0
    RESTOCKING_FEE_PER_PERCENT = 0.6
    RESTOCKING_FEE_PER_DOLLAR = 0.4
    RESTOCKING_FEE_CAP = 25.0
    RESTOCKING_FEE_FLAT_UNKNOWN = 10.0
    CONDITIONAL_FREE_SHIPPING_PENALTY = 4.0
    #: Flat weights for the remaining hidden-penalty classes, keyed by the
    #: lowercase codes emitted by semantics.parse_policy_semantics.
    HIDDEN_TERM_WEIGHTS = {
        "store_credit_only": 15.0,
        "exchange_only": 18.0,
        "customer_pays_return_shipping": 8.0,
        "final_sale_category": 10.0,
        "warranty_void": 12.0,
    }

    def __init__(
        self,
        target_max_shipping_days: int = 3,
        target_min_return_window: int = 30,
        market_baseline_score: float = 62.0,
        probability_temperature: float = 12.0,
    ) -> None:
        # Defensive coercion: the engine is constructed from CLI flags and
        # (eventually) per-merchant config rows; a bad value must degrade to
        # the documented default rather than crash an analytics worker.
        self.target_max_shipping_days = self._coerce_positive_int(
            target_max_shipping_days, default=3
        )
        self.target_min_return_window = self._coerce_positive_int(
            target_min_return_window, default=30
        )
        self.market_baseline_score = self._coerce_finite_float(
            market_baseline_score, default=62.0
        )
        temperature = self._coerce_finite_float(probability_temperature, default=12.0)
        # Temperature must be strictly positive or the logistic curve
        # degenerates (divide-by-zero / inverted slope).
        self.probability_temperature = temperature if temperature > 0 else 12.0

    # ------------------------------------------------------------------
    # Defensive coercion helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _coerce_positive_int(value: Any, default: int) -> int:
        try:
            result = int(value)
        except (TypeError, ValueError):
            return default
        return result if result >= 0 else default

    @staticmethod
    def _coerce_finite_float(value: Any, default: float) -> float:
        try:
            result = float(value)
        except (TypeError, ValueError):
            return default
        return result if math.isfinite(result) else default

    # ------------------------------------------------------------------
    # Selection probability
    # ------------------------------------------------------------------

    def selection_probability(self, score: float) -> float:
        """Logistic selection probability vs. the market baseline.

        P = 1 / (1 + exp(-(score - baseline) / temperature)).  See the
        module docstring for why this is relative-to-field, not score/100.
        Overflow-guarded: extreme (score - baseline) / temperature values
        saturate to 0.0 / 1.0 instead of raising OverflowError.
        """
        try:
            exponent = (self.market_baseline_score - float(score)) / self.probability_temperature
        except (TypeError, ValueError):
            return 0.5  # unknowable input -> coin flip, never an exception
        # math.exp overflows around 709; saturate well before that.
        if exponent > 60.0:
            return 0.0
        if exponent < -60.0:
            return 1.0
        return 1.0 / (1.0 + math.exp(exponent))

    # ------------------------------------------------------------------
    # Deduction builders (each returns Optional[Deduction])
    # ------------------------------------------------------------------

    def _shipping_deductions(self, metrics: PolicyMetrics) -> List[Deduction]:
        deductions: List[Deduction] = []
        try:
            days = int(metrics.shipping_days)
        except (TypeError, ValueError):
            days = DEFAULT_SHIPPING_DAYS

        overage = max(0, days - self.target_max_shipping_days)
        if overage > 0:
            points = min(
                overage * self.SHIPPING_OVERAGE_POINTS_PER_DAY,
                self.SHIPPING_OVERAGE_CAP,
            )
            detail = (
                f"Worst-case shipping of {days} calendar days exceeds the "
                f"{self.target_max_shipping_days}-day target by {overage} day(s)"
            )
            if metrics.business_day_conversion_applied and metrics.shipping_business_days:
                detail += (
                    f" (converted from {metrics.shipping_business_days} business "
                    f"days via ceil(n * 7/5))"
                )
            if metrics.ambiguous_shipping:
                detail += (
                    f"; {DEFAULT_SHIPPING_DAYS} days is an assumed default because "
                    f"no shipping speed was parseable"
                )
            deductions.append(
                Deduction(code="SHIP_OVERAGE", points=round(points, 2), detail=detail)
            )

        if metrics.ambiguous_shipping:
            deductions.append(
                Deduction(
                    code="SHIP_AMBIGUOUS",
                    points=round(self.AMBIGUOUS_SHIPPING_PENALTY, 2),
                    detail=(
                        "No parseable shipping speed found — agents cannot rank "
                        "what they cannot parse, so ambiguity is itself penalized "
                        "on top of the assumed-default overage"
                    ),
                )
            )
        return deductions

    def _return_deduction(self, metrics: PolicyMetrics) -> Optional[Deduction]:
        window = metrics.return_window_days
        if window is not None:
            try:
                window = int(window)
            except (TypeError, ValueError):
                window = None

        if window is None:
            # Keyed off the VALUE (not just the flag) so a metrics object
            # from a partially failed parse still scores conservatively.
            return Deduction(
                code="RETURN_UNSPECIFIED",
                points=round(self.UNSPECIFIED_RETURNS_PENALTY, 2),
                detail=(
                    "No return policy found — agents treat unspecified return "
                    "terms as buyer risk (penalized differently from a short "
                    "but explicit window)"
                ),
            )

        shortfall = max(0, self.target_min_return_window - window)
        if shortfall <= 0:
            return None
        points = shortfall * self.RETURN_SHORTFALL_POINTS_PER_DAY
        if metrics.final_sale:
            detail = (
                f'Store-wide no-returns policy ("{metrics.return_evidence}") — '
                f"a 0-day window, {shortfall} day(s) short of the "
                f"{self.target_min_return_window}-day target"
            )
        else:
            detail = (
                f"{window}-day return window falls {shortfall} day(s) short of "
                f"the {self.target_min_return_window}-day target"
            )
        return Deduction(code="RETURN_SHORT", points=round(points, 2), detail=detail)

    def _restocking_deduction(self, term: Any) -> Deduction:
        percent = getattr(term, "percent", None)
        amount = getattr(term, "amount", None)
        evidence = getattr(term, "evidence", "") or "restocking fee"
        if percent is not None:
            points = min(
                self.RESTOCKING_FEE_BASE + percent * self.RESTOCKING_FEE_PER_PERCENT,
                self.RESTOCKING_FEE_CAP,
            )
            detail = f'Restocking fee of {percent:g}% detected ("{evidence}")'
        elif amount is not None:
            points = min(
                self.RESTOCKING_FEE_BASE + amount * self.RESTOCKING_FEE_PER_DOLLAR,
                self.RESTOCKING_FEE_CAP,
            )
            detail = f'Restocking fee of ${amount:g} detected ("{evidence}")'
        else:
            points = self.RESTOCKING_FEE_FLAT_UNKNOWN
            detail = f'Restocking fee of unspecified size detected ("{evidence}")'
        return Deduction(code="RESTOCKING_FEE", points=round(points, 2), detail=detail)

    def _hidden_term_deductions(self, metrics: PolicyMetrics) -> List[Deduction]:
        deductions: List[Deduction] = []
        seen = set()
        terms = metrics.hidden_penalties or []
        for term in terms:
            code = getattr(term, "code", None)
            if not code or code in seen:
                # One deduction per penalty class — repeated FAQ mentions of
                # the same clause must not stack.
                continue
            seen.add(code)
            if code == "restocking_fee":
                deductions.append(self._restocking_deduction(term))
                continue
            weight = self.HIDDEN_TERM_WEIGHTS.get(code)
            if weight is None:
                # Unknown code from a newer parser version: skip rather than
                # guess a weight (forward compatibility without surprises).
                continue
            evidence = getattr(term, "evidence", "") or code
            human = code.replace("_", " ")
            deductions.append(
                Deduction(
                    code=code.upper(),
                    points=round(weight, 2),
                    detail=f'Hidden penalty term: {human} ("{evidence}")',
                )
            )
        return deductions

    def _free_shipping_deduction(self, metrics: PolicyMetrics) -> Optional[Deduction]:
        # Unconditional free shipping is the ABSENCE of penalty — never a
        # bonus above 100.  Only the threshold-gated variant deducts,
        # because "free*" conditions mislead agent price comparison.
        if not (metrics.free_shipping and metrics.free_shipping_conditional):
            return None
        threshold = metrics.free_shipping_threshold
        threshold_text = (
            f"${threshold:g} minimum" if threshold is not None else "a spend minimum"
        )
        return Deduction(
            code="FREE_SHIPPING_CONDITIONAL",
            points=round(self.CONDITIONAL_FREE_SHIPPING_PENALTY, 2),
            detail=(
                f'Free shipping is gated on {threshold_text} '
                f'("{metrics.free_shipping_evidence}") — conditional offers '
                f"weaken agent price comparison"
            ),
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def evaluate(self, metrics: Any) -> ScoreReport:
        """Score a PolicyMetrics fact sheet.  NEVER raises.

        A malformed/None metrics object is scored as a fully ambiguous,
        unspecified policy (the conservative agent interpretation); an
        unexpected internal failure returns a neutral baseline report with
        a zero-point ENGINE_ERROR marker instead of propagating.
        """
        try:
            if not isinstance(metrics, PolicyMetrics):
                # Defensive: treat anything malformed as a totally opaque
                # policy rather than crashing an analytics worker.
                metrics = PolicyMetrics(
                    returns_unspecified=True,
                    ambiguous_shipping=True,
                    shipping_days=DEFAULT_SHIPPING_DAYS,
                )

            deductions: List[Deduction] = []
            deductions.extend(self._shipping_deductions(metrics))
            ret = self._return_deduction(metrics)
            if ret is not None:
                deductions.append(ret)
            deductions.extend(self._hidden_term_deductions(metrics))
            free = self._free_shipping_deduction(metrics)
            if free is not None:
                deductions.append(free)

            total = sum(d.points for d in deductions)
            # Clamp to [0, 100]: deductions can exceed 100 for pathological
            # policies, and unconditional free shipping must never push the
            # score above 100 (it is modeled as zero deduction, not bonus).
            score = round(min(100.0, max(0.0, 100.0 - total)), 2)

            return ScoreReport(
                agent_match_score=score,
                selection_probability=round(self.selection_probability(score), 6),
                deductions=deductions,
                target_max_shipping_days=self.target_max_shipping_days,
                target_min_return_window=self.target_min_return_window,
                market_baseline_score=self.market_baseline_score,
                probability_temperature=self.probability_temperature,
            )
        except Exception:
            # Last-resort fallback: a neutral, clearly-marked report.  The
            # zero-point marker keeps directive gain math consistent while
            # making the failure visible in dashboards/telemetry.
            baseline = float(self.market_baseline_score)
            return ScoreReport(
                agent_match_score=baseline,
                selection_probability=0.5,
                deductions=[
                    Deduction(
                        code="ENGINE_ERROR",
                        points=0.0,
                        detail=(
                            "Internal scoring error — neutral baseline report "
                            "emitted; no deductions could be computed"
                        ),
                    )
                ],
                target_max_shipping_days=self.target_max_shipping_days,
                target_min_return_window=self.target_min_return_window,
                market_baseline_score=self.market_baseline_score,
                probability_temperature=self.probability_temperature,
            )
