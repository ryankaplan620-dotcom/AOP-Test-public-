"""
AOP :: optimizer/aop_optimizer/semantics.py
===========================================

Role in the AOP data flow
-------------------------
The Agent Optimization Platform (AOP) sits between AI shopping agents
(OpenAI/Stripe ACP, Google AP2) and headless Shopify/BigCommerce backends.
The edge proxy logs intent telemetry; the sweep job classifies intents that
expire without conversion into `loss_diagnostics`.  A recurring diagnosis is
"policy friction": the merchant's human-written shipping/return policy text
is either unattractive or *unparseable* to an LLM agent, so the agent ranks
the merchant down (or cannot rank it at all) and the intent dies.

This module is the first stage of the offline policy-scoring pipeline.  It
simulates the *extraction* step an LLM shopping agent performs when it reads
raw merchant policy text: pull out the machine-comparable facts (return
window, worst-case delivery time, free-shipping terms) and flag the "hidden
penalty" clauses (restocking fees, store-credit-only refunds, ...) that
agents treat as negative signals.  The output — a `PolicyMetrics` dataclass —
feeds `scoring.AgentOptimizationEngine` and ultimately the directive payload
served to the merchant dashboard.

Hard operational constraint: this parser runs inside analytics tooling that
must NEVER take down anything in the live request path.  Therefore
`parse_policy_semantics` is guaranteed not to raise on ANY input (None,
bytes, emoji, HTML fragments, megabyte junk strings).  Every extraction pass
is individually fault-isolated; a regex pass that fails degrades that one
metric to its conservative default instead of propagating an exception.

Stdlib only (re, math, dataclasses, typing) — no third-party dependencies.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, List, Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Calendar-day shipping assumption applied when no shipping speed can be
#: parsed at all.  7 days ~= the observed industry median for unspecified
#: standard fulfillment.  The `ambiguous_shipping` flag records that this is
#: an assumption, not a parsed fact — ambiguity is penalized separately by
#: the scoring engine because agents cannot rank what they cannot parse.
DEFAULT_SHIPPING_DAYS = 7

#: Upper bound on normalized input length.  Regex passes are linear-ish but
#: adversarial multi-megabyte inputs (scraped pages, binary junk) should not
#: burn CPU in an analytics worker.  Real policy pages are < 10 KB of text.
_MAX_TEXT_LENGTH = 20_000

#: Maximum characters of evidence text kept per extracted clause — enough
#: for a human/dashboard to locate the clause, small enough for telemetry.
_MAX_EVIDENCE_LENGTH = 160


# ---------------------------------------------------------------------------
# Dataclasses (the parser's output contract)
# ---------------------------------------------------------------------------

@dataclass
class HiddenPenaltyTerm:
    """One detected 'hidden penalty' clause with its supporting evidence.

    `code` is a stable machine identifier (lowercase snake_case) consumed by
    the scoring engine; `evidence` is the exact matched policy text so the
    merchant dashboard can show *why* the deduction was applied.  `percent`
    / `amount` are only populated for restocking fees where a magnitude was
    captured (e.g. "15% restocking fee" -> percent=15.0).
    """

    code: str
    evidence: str
    percent: Optional[float] = None
    amount: Optional[float] = None


@dataclass
class PolicyMetrics:
    """Machine-comparable facts extracted from raw merchant policy text.

    Field semantics (all defaults are the *conservative* interpretation an
    agent would fall back to when a fact is missing):

    return_window_days      None = no return terms found (see
                            `returns_unspecified`); 0 = explicit no-returns /
                            all-sales-final (see `final_sale`); otherwise the
                            parsed window in days.
    final_sale              True when a store-wide "no returns"/"all sales
                            final" statement was found.
    returns_unspecified     True when NO return information was parseable.
                            Deliberately distinct from a short window — the
                            scoring engine penalizes the two differently.
    shipping_days           Worst-case CALENDAR days to delivery.  Ranges
                            take the upper bound ("4-6 business days" -> 6);
                            business days are converted via ceil(n * 7/5).
    shipping_business_days  The raw business-day figure BEFORE conversion,
                            when the policy quoted business/working days;
                            None when the quote was already calendar days.
    business_day_conversion_applied
                            True when ceil(n * 7/5) was applied, so
                            downstream consumers can show the conversion.
    ambiguous_shipping      True when no shipping speed was parseable and
                            `shipping_days` is the DEFAULT_SHIPPING_DAYS
                            assumption rather than a parsed value.
    free_shipping           True when any free-shipping offer was found.
    free_shipping_conditional
                            True when the offer is gated on a spend
                            threshold ("free shipping on orders over $50").
    free_shipping_threshold The captured dollar threshold, if any.
    hidden_penalties        Deduplicated list of HiddenPenaltyTerm (at most
                            one entry per code — the scoring engine applies
                            one deduction per penalty class).
    source_length           Length of the normalized input actually scanned
                            (post HTML-strip / whitespace collapse) — useful
                            for telemetry sanity checks.
    """

    return_window_days: Optional[int] = None
    final_sale: bool = False
    returns_unspecified: bool = False
    return_evidence: Optional[str] = None

    shipping_days: int = DEFAULT_SHIPPING_DAYS
    shipping_business_days: Optional[int] = None
    business_day_conversion_applied: bool = False
    ambiguous_shipping: bool = True
    shipping_evidence: Optional[str] = None

    free_shipping: bool = False
    free_shipping_conditional: bool = False
    free_shipping_threshold: Optional[float] = None
    free_shipping_evidence: Optional[str] = None

    hidden_penalties: List[HiddenPenaltyTerm] = field(default_factory=list)
    source_length: int = 0


# ---------------------------------------------------------------------------
# Input normalization
# ---------------------------------------------------------------------------

# Strips HTML-ish tags so policy text scraped from a storefront page still
# parses:  "<p>30-day returns</p>" -> " 30-day returns ".  The bounded body
# ({0,200}) prevents pathological backtracking on adversarial "<" floods.
_TAG_RE = re.compile(r"<[^<>]{0,200}?>")
_WS_RE = re.compile(r"\s+")


def _normalize(raw: Any) -> str:
    """Coerce arbitrary input to a bounded, regex-friendly plain string.

    Never raises: None/bytes/objects are coerced or dropped to "".  Unicode
    dashes and curly apostrophes are folded to ASCII so a single pattern set
    handles both hand-typed and CMS-generated policy text.
    """
    if raw is None:
        return ""
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf-8", "replace")
        except Exception:  # pragma: no cover - decode with 'replace' cannot fail
            return ""
    if not isinstance(raw, str):
        try:
            raw = str(raw)
        except Exception:
            # An object whose __str__ raises: nothing usable to parse.
            return ""
    try:
        text = _TAG_RE.sub(" ", raw)
        # Fold en/em-dashes and the minus sign into '-' so "4–6 days" parses
        # like "4-6 days"; fold curly quotes so "customer’s expense" matches.
        text = (
            text.replace("–", "-")
            .replace("—", "-")
            .replace("−", "-")
            .replace("‘", "'")
            .replace("’", "'")
        )
        text = _WS_RE.sub(" ", text).strip()
        return text[:_MAX_TEXT_LENGTH]
    except Exception:
        # Absolute last resort — normalization must never break telemetry.
        return ""


# ---------------------------------------------------------------------------
# Number handling (digits + small word numbers)
# ---------------------------------------------------------------------------

_WORD_NUMBERS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}

# Digit runs are capped at 4 so a junk token like "99999999999 days" cannot
# produce an absurd metric; word numbers cover "ships in two days".
_NUM = r"(?:\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)"


def _to_int(token: Optional[str]) -> Optional[int]:
    """Parse a _NUM token defensively; None on anything unexpected."""
    if not token:
        return None
    token = token.strip().lower()
    if token in _WORD_NUMBERS:
        return _WORD_NUMBERS[token]
    try:
        return int(token)
    except (ValueError, TypeError):
        return None


def _to_float(token: Optional[str]) -> Optional[float]:
    """Parse a money/percent token defensively; None on anything unexpected."""
    if not token:
        return None
    try:
        value = float(token)
    except (ValueError, TypeError):
        return None
    # Guard against inf/nan sneaking through exotic inputs.
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return value


def _evidence(match: "re.Match[str]") -> str:
    """Trimmed, bounded evidence snippet from a regex match."""
    return match.group(0).strip(" \t,.;:").strip()[:_MAX_EVIDENCE_LENGTH]


# ---------------------------------------------------------------------------
# Return-window patterns
# ---------------------------------------------------------------------------
# Ordered by specificity; the FIRST pattern that matches wins.  Each pattern
# is annotated with example matches it must handle.

_RETURN_PATTERNS = [
    # "returns within 14 days of delivery" / "returns accepted in 30 days"
    # / "return within 14 days" / "returns are allowed up to 21 days"
    re.compile(
        rf"\breturns?\s+(?:are\s+)?(?:accepted\s+|allowed\s+|possible\s+|free\s+)?"
        rf"(?:within|in|up\s+to)\s+(?P<days>{_NUM})\s+days?",
        re.IGNORECASE,
    ),
    # "items may be returned within 30 days" / "can be returned in 14 days"
    re.compile(
        rf"\b(?:can|may|must)\s+be\s+returned\s+(?:within|in)\s+(?P<days>{_NUM})\s+days?",
        re.IGNORECASE,
    ),
    # "30-day returns" / "30 day return policy" / "60-day money-back returns"
    re.compile(
        rf"\b(?P<days>{_NUM})[\s-]*day\s+(?:hassle[\s-]*free\s+)?"
        rf"(?:money[\s-]*back\s+)?returns?\b",
        re.IGNORECASE,
    ),
    # "45-day return window" / "30-day return period" / "60 day return policy"
    re.compile(
        rf"\b(?P<days>{_NUM})[\s-]*day\s+returns?\s+(?:policy|window|period)\b",
        re.IGNORECASE,
    ),
    # "return policy: 60 days" / "Returns policy - 30 days"
    re.compile(
        rf"\breturns?\s+policy\s*[:\-]?\s*(?P<days>{_NUM})\s+days?",
        re.IGNORECASE,
    ),
    # "you have 45 days to return" / "45 days to return your order"
    re.compile(
        rf"\b(?P<days>{_NUM})\s+days?\s+to\s+return\b",
        re.IGNORECASE,
    ),
    # "no returns after 30 days" — a bounded window, NOT a final-sale store.
    # Must be tried here so the global final-sale pattern below (whose
    # "no returns" branch has a lookahead excluding "after") never claims it.
    re.compile(
        rf"\bno\s+returns?\s+(?:after|beyond|past)\s+(?P<days>{_NUM})\s+days?",
        re.IGNORECASE,
    ),
]

# Store-wide refusal of returns.  Examples: "no returns", "all sales final",
# "all sales are final", "we do not accept returns", "returns not accepted".
# The negative lookaheads keep two very different statements out:
#   "no returns AFTER 30 days"  -> that's a 30-day window (pattern above)
#   "no returns ON clearance"   -> category-scoped, handled as a hidden term
_FINAL_SALE_GLOBAL_RE = re.compile(
    r"(?:\ball\s+sales?\s+(?:are\s+)?final\b"
    r"|\bno\s+returns?\b(?!\s+(?:after|beyond|past|on|for))"
    r"|\bwe\s+do\s+not\s+accept\s+returns?\b"
    r"|\breturns?\s+(?:are\s+)?not\s+accepted\b(?!\s+(?:after|beyond|past|on|for)))",
    re.IGNORECASE,
)


def _extract_returns(text: str, metrics: PolicyMetrics) -> None:
    """Populate return_window_days / final_sale / returns_unspecified.

    Precedence: an explicit numeric window always beats a final-sale
    statement (a page saying both is almost always "window for most items,
    final sale for a category" — the category case is captured separately as
    a hidden penalty term).  Absent both, returns are 'unspecified', which
    the engine penalizes differently from a short-but-stated window.
    """
    for pattern in _RETURN_PATTERNS:
        match = pattern.search(text)
        if match is None:
            continue
        days = _to_int(match.group("days"))
        if days is None:
            continue
        metrics.return_window_days = days
        metrics.return_evidence = _evidence(match)
        metrics.returns_unspecified = False
        metrics.final_sale = False
        return

    final = _FINAL_SALE_GLOBAL_RE.search(text)
    if final is not None:
        # Explicit refusal: window is 0, flagged so scoring/directives can
        # distinguish "hostile" from "silent".
        metrics.return_window_days = 0
        metrics.final_sale = True
        metrics.returns_unspecified = False
        metrics.return_evidence = _evidence(final)
        return

    metrics.return_window_days = None
    metrics.final_sale = False
    metrics.returns_unspecified = True
    metrics.return_evidence = None


# ---------------------------------------------------------------------------
# Shipping-speed patterns
# ---------------------------------------------------------------------------

# Verbs/nouns that anchor a shipping-speed statement.  Anchoring on these
# keeps "returns within 30 days" from ever parsing as a shipping speed.
_SHIP_VERB = (
    r"(?:ships?|shipping|shipped|deliver(?:y|s|ies|ed)?|arriv(?:es|e|al)|"
    r"dispatch(?:es|ed)?|fulfill(?:s|ed|ment)?)"
)

# Explicit "verb ... in/within N[-M] [business] days" statement.  Examples:
#   "Ships in 4-6 business days"        -> lo=4 hi=6 biz  (worst case 6)
#   "delivery within 2 days"            -> lo=2
#   "delivered in 3 to 5 days"          -> lo=3 hi=5
#   "orders arrive within five days"    -> lo=five
# The gap class excludes sentence/clause punctuation so the verb and the
# number must belong to the same clause ("Delivery info: returns within 30
# days" must NOT match — the ':' breaks the gap).
_SHIP_RANGE_RE = re.compile(
    rf"\b{_SHIP_VERB}\b[^.!?:;\n]{{0,30}}?"
    rf"\b(?:within|in)\s+(?P<lo>{_NUM})"
    rf"(?:\s*(?:-|to|or)\s*(?P<hi>\d{{1,4}}))?"
    rf"\s*(?P<biz>business|working)?[\s-]*days?\b",
    re.IGNORECASE,
)

# "N-day shipping/delivery" product-page phrasing.  Examples:
#   "2-day shipping" -> 2      "3 business day delivery" -> 3 (business)
_SHIP_NDAY_RE = re.compile(
    rf"\b(?P<n>{_NUM})[\s-]*(?P<biz>business|working)?[\s-]*day\s+"
    rf"(?:shipping|delivery|dispatch|handling)\b",
    re.IGNORECASE,
)

# "same-day shipping/delivery/dispatch" -> 0 days.
_SHIP_SAMEDAY_RE = re.compile(
    r"\bsame[\s-]*day\s+(?:shipping|delivery|dispatch|fulfillment)\b",
    re.IGNORECASE,
)

# "next-day shipping", "overnight delivery", "ships overnight" -> 1 day.
# A shipping context word is REQUIRED so prose like "do not leave the
# package outside overnight" never parses as a delivery promise.
_SHIP_NEXTDAY_RE = re.compile(
    r"(?:\b(?:next[\s-]*day|overnight)\s+(?:shipping|delivery|dispatch)\b"
    r"|\b(?:ships?|delivers?|delivered|arrives?)\s+(?:next[\s-]*day|overnight)\b)",
    re.IGNORECASE,
)


def _business_to_calendar(business_days: int) -> int:
    """ceil(n * 7/5) using integer math (no float rounding surprises).

    5 business days span a full week (7 calendar days), so agents comparing
    merchants convert quotes to calendar days:  6 business -> ceil(8.4) = 9.
    """
    return (business_days * 7 + 4) // 5


def _extract_shipping(text: str, metrics: PolicyMetrics) -> None:
    """Populate shipping_days (worst-case calendar days) + ambiguity flag.

    Precedence: an explicit numeric SLA ("ships in 4-6 business days",
    "2-day shipping") beats promotional speed keywords, because merchants
    frequently advertise a paid expedited option ("overnight available!")
    next to a slower standard SLA — the numeric statement is the standard
    one.  Same-day/next-day only win when they are the only signal.
    """
    lo = hi = None
    biz_flag = None
    match = _SHIP_RANGE_RE.search(text)
    if match is not None:
        lo = _to_int(match.group("lo"))
        hi = _to_int(match.group("hi"))
        biz_flag = match.group("biz")
    if lo is None:
        match = _SHIP_NDAY_RE.search(text)
        if match is not None:
            lo = _to_int(match.group("n"))
            hi = None
            biz_flag = match.group("biz")

    if lo is not None:
        worst = max(lo, hi) if hi is not None else lo  # worst-case bound
        if biz_flag:
            metrics.shipping_business_days = worst
            metrics.business_day_conversion_applied = True
            worst = _business_to_calendar(worst)
        metrics.shipping_days = worst
        metrics.ambiguous_shipping = False
        metrics.shipping_evidence = _evidence(match)
        return

    match = _SHIP_SAMEDAY_RE.search(text)
    if match is not None:
        metrics.shipping_days = 0
        metrics.ambiguous_shipping = False
        metrics.shipping_evidence = _evidence(match)
        return

    match = _SHIP_NEXTDAY_RE.search(text)
    if match is not None:
        metrics.shipping_days = 1
        metrics.ambiguous_shipping = False
        metrics.shipping_evidence = _evidence(match)
        return

    # Nothing parseable: assume the industry-median default and flag the
    # ambiguity.  The flag drives its own scoring penalty — agents cannot
    # rank what they cannot parse, so unparseable speed is itself a defect.
    metrics.shipping_days = DEFAULT_SHIPPING_DAYS
    metrics.ambiguous_shipping = True
    metrics.shipping_evidence = None


# ---------------------------------------------------------------------------
# Free-shipping patterns
# ---------------------------------------------------------------------------

_MONEY = r"(?P<thr>\d{1,6}(?:\.\d{1,2})?)"

# Threshold-conditional offers, each annotated with example matches:
_FREE_SHIP_COND_RES = [
    # "free shipping on orders over $50" / "free standard shipping for
    # purchases above $75" / "free shipping on all orders of at least $100"
    re.compile(
        rf"\bfree\s+(?:standard\s+|ground\s+|express\s+)?shipping\b"
        rf"[^.!?\n]{{0,40}}?\b(?:orders?|purchases?)\s+"
        rf"(?:over|above|exceeding|of\s+at\s+least)\s*\$?\s*{_MONEY}",
        re.IGNORECASE,
    ),
    # "free shipping over $50"
    re.compile(
        rf"\bfree\s+shipping\s+(?:over|above)\s+\$?\s*{_MONEY}",
        re.IGNORECASE,
    ),
    # "orders over $50 ship free" / "purchases above $75 qualify for free
    # shipping"
    re.compile(
        rf"\b(?:orders?|purchases?)\s+(?:over|above|exceeding)\s+\$?\s*{_MONEY}"
        rf"\b[^.!?\n]{{0,40}}?\b(?:ships?\s+free|free\s+shipping)",
        re.IGNORECASE,
    ),
    # "spend $75 for free shipping" / "spend $75+ to unlock free shipping"
    re.compile(
        rf"\bspend\s+\$?\s*{_MONEY}\s*\+?\b[^.!?\n]{{0,40}}?\bfree\s+shipping",
        re.IGNORECASE,
    ),
]

# Any free-shipping mention at all: "free shipping", "free standard shipping".
# NOTE: will not match "free RETURN shipping" (an intervening word), which is
# correct — that is a return-cost fact, not a delivery-cost offer.
_FREE_SHIP_ANY_RE = re.compile(
    r"\bfree\s+(?:standard\s+|ground\s+|express\s+|worldwide\s+|domestic\s+)?"
    r"shipping\b",
    re.IGNORECASE,
)


def _extract_free_shipping(text: str, metrics: PolicyMetrics) -> None:
    """Classify free shipping as unconditional / conditional / absent.

    Conditional matches are found first, then STRIPPED from a working copy
    before searching for a plain "free shipping" mention.  This gives the
    right answer for both directions of overlap:
      * "free shipping on orders over $50"      -> conditional only (the
        plain pattern would otherwise also match inside the offer text);
      * "free shipping on all orders. Free express shipping over $99."
        -> unconditional wins (the better offer dominates agent ranking).
    """
    working = text
    cond_match = None
    threshold = None
    for pattern in _FREE_SHIP_COND_RES:
        m = pattern.search(working)
        if m is None:
            continue
        if cond_match is None:
            cond_match = m
            threshold = _to_float(m.group("thr"))
        # Remove every conditional offer so the unconditional probe below
        # only sees text that is NOT part of a threshold offer.
        working = pattern.sub(" ", working)

    unconditional = _FREE_SHIP_ANY_RE.search(working)
    if unconditional is not None:
        metrics.free_shipping = True
        metrics.free_shipping_conditional = False
        metrics.free_shipping_threshold = None
        metrics.free_shipping_evidence = _evidence(unconditional)
        return
    if cond_match is not None:
        metrics.free_shipping = True
        metrics.free_shipping_conditional = True
        metrics.free_shipping_threshold = threshold
        metrics.free_shipping_evidence = _evidence(cond_match)
        return
    metrics.free_shipping = False
    metrics.free_shipping_conditional = False
    metrics.free_shipping_threshold = None
    metrics.free_shipping_evidence = None


# ---------------------------------------------------------------------------
# Hidden-penalty patterns
# ---------------------------------------------------------------------------

# Restocking fee with optional magnitude on either side.  Examples:
#   "We charge a 15% restocking fee"   -> pct_b=15
#   "restocking fee of 20%"            -> pct_a=20
#   "$10 restocking fee"               -> amt_b=10
#   "restocking fee of $7.50"          -> amt_a=7.50
#   "a restocking fee applies"         -> no magnitude captured
_RESTOCK_RE = re.compile(
    r"(?:(?P<pct_b>\d{1,3}(?:\.\d+)?)\s*(?:%|percent)\s*"
    r"|\$\s*(?P<amt_b>\d{1,6}(?:\.\d{1,2})?)\s*)?"
    r"restock(?:ing)?\s+fees?"
    r"(?:\s+of\s+(?:(?P<pct_a>\d{1,3}(?:\.\d+)?)\s*(?:%|percent)"
    r"|\$\s*(?P<amt_a>\d{1,6}(?:\.\d{1,2})?)))?",
    re.IGNORECASE,
)

# Refunds trapped as store credit.  Examples: "store credit only",
# "for store credit only", "refunds issued as store credit",
# "we only offer store credit".
_STORE_CREDIT_RE = re.compile(
    r"(?:\bstore[\s-]*credit[\s-]*only\b"
    r"|\bonly\s+(?:issue|offer|provide|receive)?\s*store[\s-]*credit\b"
    r"|\brefund(?:s|ed)?\s+(?:will\s+be\s+|are\s+)?(?:issued\s+|given\s+|provided\s+)?"
    r"(?:as|in|to|via)\s+store[\s-]*credit\b"
    r"|\b(?:for|as|in)\s+store[\s-]*credit(?:\s+only)?\b)",
    re.IGNORECASE,
)

# No cash refunds at all — exchange is the only remedy.  Examples:
# "exchanges only", "exchange-only", "only eligible for exchange",
# "exchanges are the only option".
_EXCHANGE_ONLY_RE = re.compile(
    r"(?:\bexchanges?[\s-]*only\b"
    r"|\bonly\s+(?:eligible\s+)?for\s+exchanges?\b"
    r"|\bexchanges?\s+(?:are\s+)?(?:the\s+)?only\s+(?:option|remedy)\b)",
    re.IGNORECASE,
)

# Customer bears return shipping cost.  Examples:
# "customer pays return shipping", "buyers are responsible for the cost of
# return shipping", "return shipping is the customer's responsibility",
# "returned at the customer's expense".
_CUSTOMER_PAYS_RE = re.compile(
    r"(?:\b(?:customers?|buyers?|you)\s+(?:is\s+|are\s+|will\s+be\s+)?"
    r"(?:responsible\s+for|pays?|must\s+pay|covers?|bears?)\s+"
    r"(?:the\s+)?(?:cost\s+of\s+)?return\s+(?:shipping|postage)\b"
    r"|\breturn\s+(?:shipping|postage)\s+(?:costs?\s+|fees?\s+)?(?:is|are)\s+"
    r"(?:the\s+)?(?:customer|buyer)'?s?\s+responsibility\b"
    r"|\breturn(?:s|ed)?\s+(?:items?\s+)?at\s+(?:the\s+)?(?:customer|buyer)'?s?\s+"
    r"(?:own\s+)?expense\b)",
    re.IGNORECASE,
)

# Category-scoped final-sale / non-returnable carve-outs (distinct from the
# store-wide final-sale statement handled in _extract_returns).  Examples:
# "clearance items are final sale", "personalized products cannot be
# returned", "final sale items", "items marked final sale",
# "no returns on clearance".
_FINAL_SALE_CATEGORY_RE = re.compile(
    r"(?:\b(?:clearance|closeout|sale|discounted|custom|customized|"
    r"personali[sz]ed|select|certain|some|intimate|swim)\s+"
    r"(?:items?|products?|merchandise|goods|orders?|categories|pieces?)\b"
    r"[^.!?\n]{0,60}?\b(?:final[\s-]*sale|non[\s-]*returnable|non[\s-]*refundable"
    r"|cannot\s+be\s+returned|not\s+(?:be\s+)?returned"
    r"|not\s+eligible\s+for\s+returns?|no\s+returns?)"
    r"|\bfinal[\s-]*sale\s+(?:items?|products?|merchandise|categories)\b"
    r"|\b(?:items?|products?|merchandise)\s+(?:marked|labeled)\s+(?:as\s+)?"
    r"final[\s-]*sale\b"
    r"|\bno\s+returns?\s+(?:on|for)\s+(?:clearance|sale|discounted|custom|"
    r"personali[sz]ed|final[\s-]*sale)\b)",
    re.IGNORECASE,
)

# Warranty-void clauses.  Examples: "warranty void if opened",
# "warranty will be voided", "opening the enclosure voids your warranty",
# "the warranty does not apply".
_WARRANTY_VOID_RE = re.compile(
    r"(?:\bwarrant(?:y|ies)\s+(?:is\s+|are\s+|will\s+be\s+|shall\s+be\s+)?"
    r"void(?:ed)?\b"
    r"|\bvoids?\s+(?:the\s+|your\s+|all\s+|any\s+)?warrant(?:y|ies)\b"
    r"|\bwarrant(?:y|ies)\s+(?:does|do)\s+not\s+apply\b)",
    re.IGNORECASE,
)

# Simple (code, regex) penalty probes — restocking is handled separately
# because it captures a magnitude.
_SIMPLE_PENALTY_PROBES = [
    ("store_credit_only", _STORE_CREDIT_RE),
    ("exchange_only", _EXCHANGE_ONLY_RE),
    ("customer_pays_return_shipping", _CUSTOMER_PAYS_RE),
    ("final_sale_category", _FINAL_SALE_CATEGORY_RE),
    ("warranty_void", _WARRANTY_VOID_RE),
]


def _extract_hidden_penalties(text: str, metrics: PolicyMetrics) -> None:
    """Populate hidden_penalties — at most ONE term per code.

    The scoring engine deducts once per penalty class, so repeated mentions
    ("restocking fee" appearing in three FAQ answers) must not stack.  The
    first occurrence supplies the evidence text.
    """
    found: List[HiddenPenaltyTerm] = []

    restock = _RESTOCK_RE.search(text)
    if restock is not None:
        percent = _to_float(restock.group("pct_b")) or _to_float(restock.group("pct_a"))
        amount = _to_float(restock.group("amt_b")) or _to_float(restock.group("amt_a"))
        found.append(
            HiddenPenaltyTerm(
                code="restocking_fee",
                evidence=_evidence(restock),
                percent=percent,
                # Percent takes precedence when both somehow match; a
                # percent-of-order fee is the larger economic signal.
                amount=None if percent is not None else amount,
            )
        )

    for code, pattern in _SIMPLE_PENALTY_PROBES:
        match = pattern.search(text)
        if match is not None:
            found.append(HiddenPenaltyTerm(code=code, evidence=_evidence(match)))

    metrics.hidden_penalties = found


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def parse_policy_semantics(text: Any) -> PolicyMetrics:
    """Parse raw merchant policy text into PolicyMetrics.

    GUARANTEED NOT TO RAISE for any input whatsoever.  Each extraction pass
    is fault-isolated: if one pass hits an unexpected condition, that metric
    keeps its conservative default (unspecified returns / ambiguous 7-day
    shipping / no free shipping / no hidden terms) and the remaining passes
    still run.  This mirrors AOP's core operational rule — an analytics
    failure must never cascade.
    """
    try:
        normalized = _normalize(text)
    except Exception:  # pragma: no cover - _normalize already never raises
        normalized = ""

    metrics = PolicyMetrics(source_length=len(normalized))

    if not normalized:
        # Empty input: everything stays at its conservative default, but the
        # flags must be explicit so the scoring engine penalizes correctly.
        metrics.returns_unspecified = True
        metrics.ambiguous_shipping = True
        metrics.shipping_days = DEFAULT_SHIPPING_DAYS
        return metrics

    for extraction_pass in (
        _extract_returns,
        _extract_shipping,
        _extract_free_shipping,
        _extract_hidden_penalties,
    ):
        try:
            extraction_pass(normalized, metrics)
        except Exception:
            # Fault isolation: a single failed pass degrades one metric to
            # its default; it must not take down the whole parse.
            continue

    return metrics
