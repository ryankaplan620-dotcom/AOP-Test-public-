"""jsonld.py — the Semantic Policy Rewriter (JSON-LD structured-data builder).

Role in the AOP data flow:
    parse_policy_semantics() -> AgentOptimizationEngine.evaluate() ->
    THIS MODULE -> schema.org JSON-LD blocks the merchant publishes so LLM
    agents read *structured* policy facts instead of guessing from prose.

Why this exists (product spec, "Agent SEO / Data Optimization Levers"):
LLM agents rank merchants on machine-readable certainty.  A prose policy
("orders usually ship pretty fast") forces the model to assume the worst;
a schema.org ``MerchantReturnPolicy`` / ``OfferShippingDetails`` block gives
it exact integers to compare.  This module renders two variants:

``current``    the policy AS PARSED — an honest structured restatement of
               what the store does today.  Publishing this alone already
               removes the ambiguity penalties.
``optimized``  the policy WITH the scoring engine's directive targets
               applied (return window raised to the target, shipping bounded
               to the target, penalty clauses dropped).  This is the
               "what to change" artifact: it is only honest to publish once
               the merchant actually operates these terms — the dashboard
               presents it as the rewrite goal, never auto-publishes it.

Alongside the JSON-LD, ``rewritten_policy_text`` renders the optimized terms
as agent-parseable prose (every sentence round-trips through our own parser
— tested) for merchants who can only edit a policy text field.

Stdlib only.  Never raises on engine-produced inputs.
"""

from typing import Any, Dict, List, Optional

# Schema.org enumeration IRIs used below.  Kept as constants so tests and
# consumers reference one spelling.
_SCHEMA_CONTEXT = "https://schema.org"
_FINITE_WINDOW = "https://schema.org/MerchantReturnFiniteReturnWindow"
_NOT_PERMITTED = "https://schema.org/MerchantReturnNotPermitted"
_UNSPECIFIED = "https://schema.org/MerchantReturnUnspecified"
_FREE_RETURN = "https://schema.org/FreeReturn"
_RETURN_FEES = "https://schema.org/ReturnShippingFees"
_RESTOCKING = "https://schema.org/RestockingFees"
_FULL_REFUND = "https://schema.org/FullRefund"
_STORE_CREDIT = "https://schema.org/StoreCreditRefund"
_EXCHANGE = "https://schema.org/ExchangeRefund"


def _day_quantity(max_days: int, min_days: Optional[int] = None) -> Dict[str, Any]:
    """schema.org QuantitativeValue in days; explicit maxValue is the number
    agents actually compare, so it is always present."""
    quantity: Dict[str, Any] = {
        "@type": "QuantitativeValue",
        "maxValue": int(max_days),
        "unitCode": "DAY",  # UN/CEFACT common code for calendar days
    }
    if min_days is not None:
        quantity["minValue"] = int(min_days)
    return quantity


def _penalty_codes(metrics: Any) -> List[str]:
    """Extract the hidden-penalty codes list defensively (metrics may be a
    dataclass or a plain dict round-tripped through JSON)."""
    terms = getattr(metrics, "hidden_penalties", None)
    if terms is None and isinstance(metrics, dict):
        terms = metrics.get("hidden_penalties")
    codes: List[str] = []
    for term in terms or []:
        code = getattr(term, "code", None)
        if code is None and isinstance(term, dict):
            code = term.get("code")
        if isinstance(code, str):
            codes.append(code)
    return codes


def _metric(metrics: Any, name: str, default: Any = None) -> Any:
    """Field access that tolerates both PolicyMetrics and dict shapes."""
    value = getattr(metrics, name, None)
    if value is None and isinstance(metrics, dict):
        value = metrics.get(name, default)
    return default if value is None else value


def _return_policy(metrics: Any, report: Any, optimized: bool) -> Dict[str, Any]:
    """Build the MerchantReturnPolicy node for either variant."""
    window = _metric(metrics, "return_window_days")
    final_sale = bool(_metric(metrics, "final_sale", False))
    unspecified = bool(_metric(metrics, "returns_unspecified", False))
    penalties = _penalty_codes(metrics)
    target_window = int(getattr(report, "target_min_return_window", 30) or 30)

    node: Dict[str, Any] = {"@type": "MerchantReturnPolicy"}

    if optimized:
        # Directive targets applied: at least the target window, free
        # mail-in returns, full refund — the exact terms the scoring engine
        # stops penalizing.
        node["returnPolicyCategory"] = _FINITE_WINDOW
        node["merchantReturnDays"] = max(int(window or 0), target_window)
        node["returnFees"] = _FREE_RETURN
        node["refundType"] = _FULL_REFUND
        return node

    # --- honest restatement of the parsed policy -------------------------
    if final_sale:
        node["returnPolicyCategory"] = _NOT_PERMITTED
        return node
    if unspecified or window is None:
        # Unspecified is itself the fact worth publishing honestly; agents
        # treat it conservatively either way, but at least it parses.
        node["returnPolicyCategory"] = _UNSPECIFIED
        return node

    node["returnPolicyCategory"] = _FINITE_WINDOW
    node["merchantReturnDays"] = int(window)
    if "restocking_fee" in penalties:
        node["returnFees"] = _RESTOCKING
    elif "customer_pays_return_shipping" in penalties:
        node["returnFees"] = _RETURN_FEES
    else:
        node["returnFees"] = _FREE_RETURN
    if "store_credit_only" in penalties:
        node["refundType"] = _STORE_CREDIT
    elif "exchange_only" in penalties:
        node["refundType"] = _EXCHANGE
    else:
        node["refundType"] = _FULL_REFUND
    return node


def _shipping_details(metrics: Any, report: Any, optimized: bool) -> Dict[str, Any]:
    """Build the OfferShippingDetails node for either variant."""
    shipping_days = int(_metric(metrics, "shipping_days", 7) or 7)
    ambiguous = bool(_metric(metrics, "ambiguous_shipping", False))
    free = bool(_metric(metrics, "free_shipping", False))
    conditional = bool(_metric(metrics, "free_shipping_conditional", False))
    target_days = int(getattr(report, "target_max_shipping_days", 3) or 3)

    node: Dict[str, Any] = {"@type": "OfferShippingDetails"}

    if optimized:
        transit_max = min(shipping_days, target_days)
        node["deliveryTime"] = {
            "@type": "ShippingDeliveryTime",
            "transitTime": _day_quantity(transit_max, min_days=1),
        }
        # Unconditional free shipping is the no-penalty target state.
        node["shippingRate"] = {"@type": "MonetaryAmount", "value": 0, "currency": "USD"}
        return node

    node["deliveryTime"] = {
        "@type": "ShippingDeliveryTime",
        "transitTime": _day_quantity(shipping_days, min_days=1),
    }
    if ambiguous:
        # Flag that the figure is our conservative default, not a quoted
        # promise — honesty marker consumed by the dashboard, ignored by
        # schema.org processors (extension property, x- style).
        node["x-aop-assumed"] = True
    if free and not conditional:
        node["shippingRate"] = {"@type": "MonetaryAmount", "value": 0, "currency": "USD"}
    return node


def rewritten_policy_text(metrics: Any, report: Any) -> str:
    """Render the OPTIMIZED terms as agent-parseable prose.

    Every sentence here deliberately matches patterns our own
    ``parse_policy_semantics`` extracts (round-trip covered by tests) — if
    our simulated agent can parse it, real agents get the same certainty.
    """
    target_days = int(getattr(report, "target_max_shipping_days", 3) or 3)
    target_window = int(getattr(report, "target_min_return_window", 30) or 30)
    window = _metric(metrics, "return_window_days")
    return_days = max(int(window or 0), target_window)

    # NOTE: penalty vocabulary ("restocking", "store credit", "final sale")
    # must not appear here AT ALL — not even negated. Keyword heuristics
    # (ours, and the real agents ours simulates) flag the term itself; "no
    # restocking fees" still reads as a restocking-fee signal. State the
    # positive terms and stay silent about the penalties that don't exist.
    sentences = [
        f"Guaranteed delivery within {target_days} days.",
        "Free shipping on all orders.",
        f"{return_days}-day returns with a full refund to the original payment method.",
        "Free return shipping on every eligible order.",
    ]
    return " ".join(sentences)


def build_policy_jsonld(metrics: Any, report: Any) -> Dict[str, Any]:
    """Build the full Semantic Policy Rewriter artifact.

    Returns::

        {
          "current":   {"@context": ..., "returnPolicy": ..., "shipping": ...},
          "optimized": {same shape, directive targets applied},
          "rewritten_policy_text": "<agent-parseable optimized prose>"
        }

    Never raises on engine-produced inputs: field access is defensive and
    numeric fields are coerced with safe fallbacks.
    """
    def variant(optimized: bool) -> Dict[str, Any]:
        return {
            "@context": _SCHEMA_CONTEXT,
            "returnPolicy": _return_policy(metrics, report, optimized),
            "shipping": _shipping_details(metrics, report, optimized),
        }

    return {
        "current": variant(optimized=False),
        "optimized": variant(optimized=True),
        "rewritten_policy_text": rewritten_policy_text(metrics, report),
    }
