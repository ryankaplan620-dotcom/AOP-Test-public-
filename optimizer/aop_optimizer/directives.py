"""
AOP :: optimizer/aop_optimizer/directives.py
============================================

Role in the AOP data flow
-------------------------
Final stage of the offline policy-scoring pipeline.  `semantics.py` extracts
`PolicyMetrics` from raw policy text and `scoring.py` produces a
`ScoreReport`; this module assembles the machine-actionable payload that the
AOP dashboard (and, later, an auto-rewrite service) consumes.  Every
directive is an EXACT semantic rewrite — detected text, target text, and the
score points recovered by making the change — so a merchant (or an agent
acting for the merchant) can apply it verbatim.

Payload JSON schema (schema_version 1.0.0)
------------------------------------------
{
  "schema_version": "1.0.0",           // semver of THIS payload contract
  "agent_match_score": 10.0,           // absolute score, 0-100
  "selection_probability": 0.012956,   // logistic P(selected) vs. baseline
  "extracted_metrics": {               // serialized semantics.PolicyMetrics
    "return_window_days": 14,          //   int | null (null = unspecified)
    "final_sale": false,               //   bool
    "returns_unspecified": false,      //   bool
    "return_evidence": "...",          //   str | null (matched policy text)
    "shipping_days": 9,                //   int, worst-case CALENDAR days
    "shipping_business_days": 6,       //   int | null, pre-conversion figure
    "business_day_conversion_applied": true,   // bool, ceil(n*7/5) applied
    "ambiguous_shipping": false,       //   bool, true => shipping_days is a
                                       //   default assumption, not parsed
    "shipping_evidence": "...",        //   str | null
    "free_shipping": false,            //   bool
    "free_shipping_conditional": false,//   bool
    "free_shipping_threshold": null,   //   float | null, captured $ minimum
    "free_shipping_evidence": null,    //   str | null
    "hidden_penalties": [              //   deduped, one entry per code
      {"code": "restocking_fee", "evidence": "15% restocking fee",
       "percent": 15.0, "amount": null}
    ],
    "source_length": 103               //   normalized chars scanned
  },
  "applied_deductions": [              // scoring.Deduction list, engine order
    {"code": "SHIP_OVERAGE", "points": 45.0, "detail": "..."}
  ],
  "optimization_directives": [         // sorted by projected gain DESC
    {
      "priority": 1,                   // 1 = highest (assigned after sort)
      "code": "REWRITE_SHIPPING_SLA",  // stable machine identifier
      "field": "shipping_policy",      // which policy surface to edit
      "detected": "Ships in 4-6 business days",   // exact offending text
      "target": "Guaranteed delivery within 3 days",  // exact replacement
      "action": "Replace \"...\" with \"...\"",   // human/agent instruction
      "projected_score_gain": 45.0     // exactly the deduction it recovers
    }
  ]
}

Invariant: every recoverable deduction maps into exactly one directive, so
sum(projected_score_gain) == 100 - agent_match_score whenever the score did
not clamp at 0.  (For pathological policies whose raw deductions exceed 100,
the projected gains still describe the full recovery and therefore exceed
100 - score — the clamp loses information by design, the directives do not.)
The ambiguous-shipping case merges its two deductions (assumed-default
overage + ambiguity flat) into ONE directive, because a single rewrite —
publishing an explicit SLA — recovers both.

Stdlib only (dataclasses, typing).
"""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any, Dict, List, Optional

from .scoring import ScoreReport
from .semantics import PolicyMetrics

#: Semver of the payload contract documented above.  Bump on any change to
#: field names/meanings so downstream consumers (dashboard, auto-rewriter)
#: can gate on it.
SCHEMA_VERSION = "1.0.0"


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _deduction_points(deductions: Dict[str, Any], code: str) -> float:
    """Points for a deduction code, 0.0 when absent (defensive lookup)."""
    entry = deductions.get(code)
    if entry is None:
        return 0.0
    try:
        return float(entry.points)
    except (TypeError, ValueError, AttributeError):
        return 0.0


def _penalty_evidence(metrics: PolicyMetrics, code: str, fallback: str) -> str:
    """Evidence text for a hidden-penalty code, with a safe fallback."""
    try:
        for term in metrics.hidden_penalties or []:
            if getattr(term, "code", None) == code:
                evidence = getattr(term, "evidence", None)
                if evidence:
                    return str(evidence)
    except Exception:
        pass
    return fallback


def _directive(
    code: str,
    field_name: str,
    detected: str,
    target: str,
    action: str,
    gain: float,
) -> Dict[str, Any]:
    """Build one directive dict (priority assigned later, post-sort)."""
    return {
        "priority": 0,  # placeholder — assigned after the gain-desc sort
        "code": code,
        "field": field_name,
        "detected": detected,
        "target": target,
        "action": action,
        "projected_score_gain": round(float(gain), 2),
    }


# ---------------------------------------------------------------------------
# Directive builders — one per recoverable deduction (shipping merges two)
# ---------------------------------------------------------------------------


def _build_directives(
    metrics: PolicyMetrics, report: ScoreReport, deductions: Dict[str, Any]
) -> List[Dict[str, Any]]:
    directives: List[Dict[str, Any]] = []
    ship_target = f"Guaranteed delivery within {report.target_max_shipping_days} days"
    return_target = (
        f"Free returns within {report.target_min_return_window} days of delivery"
    )

    # --- shipping ------------------------------------------------------
    overage_pts = _deduction_points(deductions, "SHIP_OVERAGE")
    ambiguous_pts = _deduction_points(deductions, "SHIP_AMBIGUOUS")
    if ambiguous_pts > 0:
        # ONE rewrite (publish an explicit SLA) recovers BOTH the ambiguity
        # penalty and the overage charged on the assumed default — merged so
        # the merchant is not told to fix the same sentence twice.
        directives.append(
            _directive(
                code="DECLARE_SHIPPING_SLA",
                field_name="shipping_policy",
                detected="No parseable shipping speed found in policy text",
                target=ship_target,
                action=(
                    f'Add an explicit fulfillment promise such as '
                    f'"{ship_target}." Agents cannot rank unparseable '
                    f"shipping speed and assume a slow default."
                ),
                gain=overage_pts + ambiguous_pts,
            )
        )
    elif overage_pts > 0:
        detected = (
            metrics.shipping_evidence
            or f"{metrics.shipping_days}-day worst-case shipping"
        )
        directives.append(
            _directive(
                code="REWRITE_SHIPPING_SLA",
                field_name="shipping_policy",
                detected=detected,
                target=ship_target,
                action=f'Replace "{detected}" with "{ship_target}."',
                gain=overage_pts,
            )
        )

    # --- returns -------------------------------------------------------
    unspecified_pts = _deduction_points(deductions, "RETURN_UNSPECIFIED")
    short_pts = _deduction_points(deductions, "RETURN_SHORT")
    if unspecified_pts > 0:
        directives.append(
            _directive(
                code="DECLARE_RETURN_POLICY",
                field_name="return_policy",
                detected="No return policy found in policy text",
                target=return_target,
                action=(
                    f'Publish an explicit return policy such as '
                    f'"{return_target}." Agents treat missing return terms '
                    f"as buyer risk."
                ),
                gain=unspecified_pts,
            )
        )
    elif short_pts > 0:
        if metrics.final_sale:
            detected = metrics.return_evidence or "all sales final"
            directives.append(
                _directive(
                    code="REVERSE_FINAL_SALE",
                    field_name="return_policy",
                    detected=detected,
                    target=return_target,
                    action=f'Replace "{detected}" with "{return_target}."',
                    gain=short_pts,
                )
            )
        else:
            detected = (
                metrics.return_evidence
                or f"{metrics.return_window_days}-day return window"
            )
            directives.append(
                _directive(
                    code="EXTEND_RETURN_WINDOW",
                    field_name="return_policy",
                    detected=detected,
                    target=return_target,
                    action=f'Replace "{detected}" with "{return_target}."',
                    gain=short_pts,
                )
            )

    # --- hidden penalty terms -----------------------------------------
    restock_pts = _deduction_points(deductions, "RESTOCKING_FEE")
    if restock_pts > 0:
        detected = _penalty_evidence(metrics, "restocking_fee", "restocking fee")
        directives.append(
            _directive(
                code="REMOVE_RESTOCKING_FEE",
                field_name="return_fees",
                detected=detected,
                target="No restocking fees",
                action=f'Replace "{detected}" with "No restocking fees."',
                gain=restock_pts,
            )
        )

    store_credit_pts = _deduction_points(deductions, "STORE_CREDIT_ONLY")
    if store_credit_pts > 0:
        detected = _penalty_evidence(metrics, "store_credit_only", "store credit only")
        target = "Full refunds to your original payment method"
        directives.append(
            _directive(
                code="OFFER_ORIGINAL_PAYMENT_REFUNDS",
                field_name="refund_method",
                detected=detected,
                target=target,
                action=f'Replace "{detected}" with "{target}."',
                gain=store_credit_pts,
            )
        )

    exchange_pts = _deduction_points(deductions, "EXCHANGE_ONLY")
    if exchange_pts > 0:
        detected = _penalty_evidence(metrics, "exchange_only", "exchanges only")
        target = "Refunds or exchanges — your choice"
        directives.append(
            _directive(
                code="OFFER_REFUNDS",
                field_name="refund_method",
                detected=detected,
                target=target,
                action=f'Replace "{detected}" with "{target}."',
                gain=exchange_pts,
            )
        )

    customer_pays_pts = _deduction_points(deductions, "CUSTOMER_PAYS_RETURN_SHIPPING")
    if customer_pays_pts > 0:
        detected = _penalty_evidence(
            metrics, "customer_pays_return_shipping", "customer pays return shipping"
        )
        target = "Free prepaid return shipping on all orders"
        directives.append(
            _directive(
                code="OFFER_FREE_RETURN_SHIPPING",
                field_name="return_shipping_cost",
                detected=detected,
                target=target,
                action=f'Replace "{detected}" with "{target}."',
                gain=customer_pays_pts,
            )
        )

    category_pts = _deduction_points(deductions, "FINAL_SALE_CATEGORY")
    if category_pts > 0:
        detected = _penalty_evidence(
            metrics, "final_sale_category", "final sale categories"
        )
        target = "All items are eligible for return"
        directives.append(
            _directive(
                code="REMOVE_CATEGORY_EXCLUSIONS",
                field_name="category_exclusions",
                detected=detected,
                target=target,
                action=f'Replace "{detected}" with "{target}."',
                gain=category_pts,
            )
        )

    warranty_pts = _deduction_points(deductions, "WARRANTY_VOID")
    if warranty_pts > 0:
        detected = _penalty_evidence(metrics, "warranty_void", "warranty void clause")
        target = "Full manufacturer warranty honored on all purchases"
        directives.append(
            _directive(
                code="REMOVE_WARRANTY_VOID_CLAUSE",
                field_name="warranty_terms",
                detected=detected,
                target=target,
                action=f'Replace "{detected}" with "{target}."',
                gain=warranty_pts,
            )
        )

    # --- conditional free shipping ------------------------------------
    cond_ship_pts = _deduction_points(deductions, "FREE_SHIPPING_CONDITIONAL")
    if cond_ship_pts > 0:
        detected = metrics.free_shipping_evidence or "threshold-conditional free shipping"
        target = "Free shipping on all orders"
        directives.append(
            _directive(
                code="UNCONDITIONAL_FREE_SHIPPING",
                field_name="shipping_cost",
                detected=detected,
                target=target,
                action=f'Replace "{detected}" with "{target}."',
                gain=cond_ship_pts,
            )
        )

    # Highest recovery first; alphabetical code as a deterministic
    # tiebreaker so payloads are stable across runs.
    directives.sort(key=lambda d: (-d["projected_score_gain"], d["code"]))
    for rank, directive in enumerate(directives, start=1):
        directive["priority"] = rank
    return directives


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def build_directive_payload(metrics: Any, report: Any) -> Dict[str, Any]:
    """Assemble the schema_version 1.0.0 payload documented above.

    NEVER raises: malformed inputs degrade to a minimal-but-valid payload
    (empty metrics / empty directive list) so a payload-assembly bug can
    never break the analytics pipeline that calls it.
    """
    # Defensive input coercion — accept only real dataclass instances,
    # otherwise fall back to conservative empties.
    if not isinstance(metrics, PolicyMetrics):
        metrics = PolicyMetrics()
    if not isinstance(report, ScoreReport):
        report = ScoreReport(agent_match_score=0.0, selection_probability=0.0)

    try:
        deduction_index = {
            getattr(d, "code", ""): d for d in (report.deductions or [])
        }
        directives = _build_directives(metrics, report, deduction_index)
    except Exception:
        # Directive assembly must never take the payload down with it.
        directives = []

    try:
        extracted = asdict(metrics) if is_dataclass(metrics) else {}
    except Exception:
        extracted = {}

    applied: List[Dict[str, Any]] = []
    for d in report.deductions or []:
        try:
            applied.append(
                {
                    "code": str(getattr(d, "code", "")),
                    "points": round(float(getattr(d, "points", 0.0)), 2),
                    "detail": str(getattr(d, "detail", "")),
                }
            )
        except (TypeError, ValueError):
            continue  # skip a malformed deduction, keep the payload valid

    return {
        "schema_version": SCHEMA_VERSION,
        "agent_match_score": report.agent_match_score,
        "selection_probability": report.selection_probability,
        "extracted_metrics": extracted,
        "applied_deductions": applied,
        "optimization_directives": directives,
    }
