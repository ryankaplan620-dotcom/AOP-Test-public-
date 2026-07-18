<!--
AOP :: optimizer/README.md
Documentation for the Agent Optimization (policy scoring) engine — the
offline analytics component of the Agent Optimization Platform.  Explains
where this module sits in the AOP data flow, the scoring model, the
selection-probability formula, and how to run it.
-->

# AOP Policy Scoring Engine (`aop_optimizer`)

Part of the **Agent Optimization Platform (AOP)** — the merchant analytics
layer that proxies AI shopping agents (OpenAI/Stripe ACP, Google AP2) to
headless Shopify/BigCommerce backends. While the Cloudflare Worker edge
proxy handles live `/availability` and `/shipping_quote` traffic and the
ingestion service stitches attribution via `X-Agent-Transaction-Token`,
**this** component answers the question surfaced by `loss_diagnostics`
rows: *why do agents rank this merchant down, and what exact policy text
should change?*

It simulates how an LLM shopping agent evaluates raw merchant policy text
and produces:

1. an absolute **Agent Match Score** (0–100),
2. a normalized **Selection Probability** (logistic, relative to the
   category market baseline), and
3. machine-actionable **optimization directives** — exact semantic
   rewrites with the score points each one recovers.

Pure Python 3.11 standard library. No pip dependencies. Guaranteed
non-raising on arbitrary input — an analytics failure must never break the
merchant's live traffic.

## Pipeline

```
raw policy text
  └─ parse_policy_semantics()        semantics.py — regex + heuristics
       └─ PolicyMetrics
            └─ AgentOptimizationEngine.evaluate()   scoring.py
                 └─ ScoreReport
                      └─ build_directive_payload()  directives.py
                           └─ JSON payload (schema_version 1.0.0)
```

## Usage

Library:

```python
from aop_optimizer import (
    AgentOptimizationEngine, build_directive_payload, parse_policy_semantics,
)

metrics = parse_policy_semantics(policy_text)
report  = AgentOptimizationEngine().evaluate(metrics)
payload = build_directive_payload(metrics, report)
```

CLI (reads stdin, or `--file PATH`):

```
python3 -m aop_optimizer [--file PATH] [--pretty] [--baseline N] [--temperature N]
```

| Flag | Meaning | Default |
| --- | --- | --- |
| `--file PATH` | read policy text from a file instead of stdin | stdin |
| `--pretty` | indent the JSON output | compact |
| `--baseline N` | `market_baseline_score` for the probability curve | 62 |
| `--temperature N` | `probability_temperature` (must be > 0) | 12 |

Exit codes: `0` success, `2` usage error (empty input, unreadable file, bad
flag values — explanation on stderr), `1` unexpected internal failure.

## What the parser extracts

* **Return windows** — `"30-day returns"`, `"returns within 14 days of
  delivery"`, `"return policy: 60 days"`, `"you have 45 days to return"`,
  `"no returns after 30 days"` (a bounded window). `"no returns"` /
  `"all sales final"` → window 0 with `final_sale=true`. Nothing parseable
  → `null` with `returns_unspecified=true` (penalized *differently* from a
  short window).
* **Shipping speed** — worst-case bound of ranges (`"ships in 4-6 business
  days"` → 6), `"delivery within 2 days"`, `"2-day shipping"`,
  `"next-day"`/`"overnight"` → 1, `"same-day"` → 0. Business days convert
  to calendar days via `ceil(n * 7/5)` with the conversion recorded
  (`6 business → 9 calendar`). Nothing parseable → default 7 calendar days
  plus `ambiguous_shipping=true`.
* **Free shipping** — unconditional vs threshold-conditional
  (`"free shipping on orders over $50"` → conditional, threshold 50.0).
* **Hidden penalty terms** (each with evidence text): restocking fees
  (% or $ captured), store-credit-only refunds, exchange-only,
  customer-pays-return-shipping, final-sale/non-returnable categories,
  warranty-void clauses.

## Scoring model

The score starts at **100** and applies weighted deductions, clamped to
[0, 100]. Unconditional free shipping is the *absence* of penalty — never
a bonus above 100.

| Code | Weight | Notes |
| --- | --- | --- |
| `SHIP_OVERAGE` | 15 pts / calendar day over target (default 3), **capped at 45** | beyond 3 days over target, agents have already deprioritized — deeper slowness adds no discrimination |
| `SHIP_AMBIGUOUS` | flat 10 | unparseable speed; applied **on top of** the overage charged on the assumed 7-day default — agents cannot rank what they cannot parse |
| `RETURN_SHORT` | 1 pt / day short of target window (default 30) | store-wide final sale = 0-day window → full 30 pts |
| `RETURN_UNSPECIFIED` | flat 18 | silence ≠ short: penalized between a mildly short window and an explicit refusal |
| `RESTOCKING_FEE` | 5 base + 0.6/% or 0.4/$, capped 25; flat 10 if size unknown | scales with the captured fee |
| `STORE_CREDIT_ONLY` | flat 15 | refund value trapped with the merchant |
| `EXCHANGE_ONLY` | flat 18 | no cash remedy at all |
| `CUSTOMER_PAYS_RETURN_SHIPPING` | flat 8 | |
| `FINAL_SALE_CATEGORY` | flat 10 | category carve-outs from returns |
| `WARRANTY_VOID` | flat 12 | |
| `FREE_SHIPPING_CONDITIONAL` | flat 4 | threshold-gated "free\*" misleads agent price comparison |

Engine baselines are constructor-configurable:
`target_max_shipping_days=3`, `target_min_return_window=30`,
`market_baseline_score=62`, `probability_temperature=12`.

## Selection probability

```
P(selected) = 1 / (1 + exp(-(score - market_baseline_score) / probability_temperature))
```

A logistic curve against the configurable market baseline — **not**
`score / 100`. Shopping agents do not award business in proportion to
absolute quality; they pick winners *relative to the category field*. A
merchant scoring exactly at the baseline (62) is a coin flip (P = 0.5);
scores above the field saturate toward certainty, scores below collapse
toward zero. Mid-pack absolute scores therefore collapse toward 0.5
instead of the misleading 0.62 that `score/100` would report. The
temperature controls how sharply the curve saturates.

## Directives

Each recoverable deduction maps to exactly **one** directive containing the
exact detected text, the exact replacement text, and
`projected_score_gain` equal to the deduction it recovers — so for any
non-clamped policy, `sum(projected_score_gain) == 100 - agent_match_score`.
Directives are sorted by projected gain descending; `priority` 1 is the
highest. The ambiguous-shipping case merges its two deductions
(assumed-default overage + ambiguity flat) into one `DECLARE_SHIPPING_SLA`
directive, because a single rewrite — publishing an explicit SLA — recovers
both. The full payload JSON schema is documented in
`aop_optimizer/directives.py`.

## Example run

```
$ echo "We charge a 15% restocking fee. Returns within 14 days for store credit only. Ships in 4-6 business days." \
    | python3 -m aop_optimizer --pretty
```

Output (abridged — deductions and metrics omitted):

```json
{
  "schema_version": "1.0.0",
  "agent_match_score": 10.0,
  "selection_probability": 0.012954,
  "extracted_metrics": {
    "return_window_days": 14,
    "shipping_days": 9,
    "shipping_business_days": 6,
    "business_day_conversion_applied": true,
    "hidden_penalties": [
      {"code": "restocking_fee", "evidence": "15% restocking fee", "percent": 15.0, "amount": null},
      {"code": "store_credit_only", "evidence": "for store credit only", "percent": null, "amount": null}
    ]
  },
  "applied_deductions": [
    {"code": "SHIP_OVERAGE", "points": 45.0, "detail": "Worst-case shipping of 9 calendar days exceeds the 3-day target by 6 day(s) (converted from 6 business days via ceil(n * 7/5))"},
    {"code": "RETURN_SHORT", "points": 16.0, "detail": "14-day return window falls 16 day(s) short of the 30-day target"},
    {"code": "RESTOCKING_FEE", "points": 14.0, "detail": "Restocking fee of 15% detected (\"15% restocking fee\")"},
    {"code": "STORE_CREDIT_ONLY", "points": 15.0, "detail": "Hidden penalty term: store credit only (\"for store credit only\")"}
  ],
  "optimization_directives": [
    {
      "priority": 1,
      "code": "REWRITE_SHIPPING_SLA",
      "field": "shipping_policy",
      "detected": "Ships in 4-6 business days",
      "target": "Guaranteed delivery within 3 days",
      "action": "Replace \"Ships in 4-6 business days\" with \"Guaranteed delivery within 3 days.\"",
      "projected_score_gain": 45.0
    },
    {
      "priority": 2,
      "code": "EXTEND_RETURN_WINDOW",
      "field": "return_policy",
      "detected": "Returns within 14 days",
      "target": "Free returns within 30 days of delivery",
      "action": "Replace \"Returns within 14 days\" with \"Free returns within 30 days of delivery.\"",
      "projected_score_gain": 16.0
    },
    {
      "priority": 3,
      "code": "OFFER_ORIGINAL_PAYMENT_REFUNDS",
      "field": "refund_method",
      "detected": "for store credit only",
      "target": "Full refunds to your original payment method",
      "action": "Replace \"for store credit only\" with \"Full refunds to your original payment method.\"",
      "projected_score_gain": 15.0
    },
    {
      "priority": 4,
      "code": "REMOVE_RESTOCKING_FEE",
      "field": "return_fees",
      "detected": "15% restocking fee",
      "target": "No restocking fees",
      "action": "Replace \"15% restocking fee\" with \"No restocking fees.\"",
      "projected_score_gain": 14.0
    }
  ]
}
```

Note the gain-consistency invariant: 45 + 16 + 15 + 14 = 90 = 100 − 10.

## Tests

```
cd optimizer && python3 -m unittest discover -v
```

105 stdlib-unittest cases cover every parser pattern, the scoring edges
(clean policy → 100, pathological → 0), probability monotonicity and
baseline behavior, directive gain consistency, and the CLI (in-process).
