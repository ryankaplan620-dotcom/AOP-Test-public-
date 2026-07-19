/**
 * demo/lib/scenarios.js — pure scenario generation for the AOP demo harness.
 *
 * Role in the AOP data flow (demo only — never deployed):
 *   [agent-simulator] --(these scenarios)--> telemetry records + signed
 *   webhooks --> ingestion service --> the same tables/dashboards a real
 *   merchant would see.
 *
 * Each scenario models one AI shopping agent session against the demo
 * storefront: which protocol is calling, which SKU it probes, what the
 * quoted price/shipping looked like, and whether the agent ultimately BUYS
 * (a signed orders/create webhook follows) or WALKS (the intent expires into
 * loss_diagnostics, with payload evidence steering the classifier toward a
 * specific reason).
 *
 * PURE module (no I/O, injected RNG) so the distribution is unit-testable:
 * the demo is only convincing if every loss reason actually shows up on the
 * dashboard.
 */

/** The demo store's catalog — SKUs match the product wireframe. */
export const CATALOG = [
  { sku: 'RT-SWTR-RD', title: 'Red Thread Sweater', price: 45.0 },
  { sku: 'RT-JNS-BLU', title: 'Blue Selvedge Jeans', price: 89.5 },
  { sku: 'RT-TSH-WHT', title: 'White Heavyweight Tee', price: 24.0 },
  { sku: 'RT-HAT-GRN', title: 'Green Wool Cap', price: 32.0 },
  { sku: 'RT-JKT-BLK', title: 'Black Chore Jacket', price: 129.0 },
];

export const PROTOCOLS = ['STRIPE_ACP', 'GOOGLE_AP2', 'VISA_INTELLIGENT_COMMERCE'];

/**
 * Prompt-context strings per outcome, exercising Context Reconstruction
 * (services/ingestion/src/lib/intent-classifier.js). Losing sessions carry
 * prompts thematically consistent with why they walk (a price-sensitive
 * prompt for a price loss); WON sessions mix categories.
 */
export const PROMPTS = {
  WON: [
    'need an anniversary gift delivered by tomorrow',
    'best quality sweater that is durable',
    'reorder the same jeans again',
  ],
  PRICE_DISCREPANCY: [
    'cheapest heavyweight tee under $30',
    'best deal on selvedge jeans',
  ],
  SHIPPING_LATENCY: [
    'birthday present, needs to arrive by friday',
    'urgent gift for my wife asap',
  ],
  STOCK_OUTAGE: [
    'wool cap in XL, top-rated',
  ],
  PROTOCOL_ERROR: [],
  UNKNOWN_DROPOFF: [
    'comparing options and reviews for chore jackets',
    'blue jacket size medium', // context seen, unclassifiable -> UNCLASSIFIED
  ],
};

/**
 * Outcome mix. Weights chosen so a few minutes of simulation populates every
 * dashboard element: ~30% conversions, and every loss reason represented.
 * The loss shapes mirror what src/lib/loss-classifier.js keys on:
 *   PRICE_DISCREPANCY  competitor_benchmark below our price
 *   SHIPPING_LATENCY   quoted delivery days over the 3-day agent target
 *   STOCK_OUTAGE       requested variant unavailable
 *   PROTOCOL_ERROR     edge observed a non-2xx origin status
 *   UNKNOWN_DROPOFF    clean-looking ping that simply never converts
 */
export const OUTCOME_WEIGHTS = [
  { outcome: 'WON', weight: 30 },
  { outcome: 'PRICE_DISCREPANCY', weight: 20 },
  { outcome: 'SHIPPING_LATENCY', weight: 20 },
  { outcome: 'STOCK_OUTAGE', weight: 10 },
  { outcome: 'PROTOCOL_ERROR', weight: 5 },
  { outcome: 'UNKNOWN_DROPOFF', weight: 15 },
];

/** Weighted pick with an injected rng ([0,1) float source). */
export function weightedPick(entries, rng) {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  let roll = rng() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll < 0) return entry;
  }
  return entries[entries.length - 1]; // float-edge fallback
}

/** Demo transaction token: recognizable prefix + monotonic + entropy. */
export function mintToken(sequence, rng) {
  return `demo_tok_${String(sequence).padStart(6, '0')}_${Math.floor(rng() * 1e6).toString(36)}`;
}

/**
 * Build one agent-session scenario.
 *
 * @param {number} sequence monotonic session number (token uniqueness).
 * @param {() => number} rng injected [0,1) source (Math.random in the demo
 *   runner, seeded/deterministic in tests).
 * @returns {{
 *   token: string, protocol: string, sku: string, price: number,
 *   outcome: string, converts: boolean,
 *   probes: Array<{path: string, method: string, payload: object|null, status: number}>,
 *   orderTotal: string|null
 * }}
 */
export function buildScenario(sequence, rng) {
  const product = CATALOG[Math.floor(rng() * CATALOG.length)];
  const protocol = PROTOCOLS[Math.floor(rng() * PROTOCOLS.length)];
  const { outcome } = weightedPick(OUTCOME_WEIGHTS, rng);
  const token = mintToken(sequence, rng);
  const converts = outcome === 'WON';

  // Every session starts with an availability probe (the "impression").
  const probes = [
    {
      path: '/availability',
      method: 'GET',
      payload: null,
      status: outcome === 'PROTOCOL_ERROR' ? 502 : 200,
    },
  ];

  // Most sessions follow with a shipping-quote probe carrying the evidence
  // the loss classifier reads. PROTOCOL_ERROR sessions stop at the failed
  // availability ping (an agent won't quote shipping on a dead origin).
  if (outcome !== 'PROTOCOL_ERROR') {
    const quoteDays =
      outcome === 'SHIPPING_LATENCY'
        ? 5 + Math.floor(rng() * 3) // 5-7 days: over the 3-day agent target
        : 1 + Math.floor(rng() * 2); // 1-2 days: agent-acceptable

    const prompts = PROMPTS[outcome] ?? [];
    const payload = {
      items: [{ sku: product.sku, quantity: 1 }],
      quoted_price: product.price,
      delivery_days: quoteDays,
      destination: { zip: '94107', province: 'CA', country: 'US' },
    };
    // Context Reconstruction fodder: most sessions carry a prompt excerpt.
    if (prompts.length > 0 && rng() < 0.85) {
      payload.prompt = prompts[Math.floor(rng() * prompts.length)];
    }

    if (outcome === 'PRICE_DISCREPANCY') {
      // Competitor undercuts us. Field name matters: the loss classifier
      // (services/ingestion/src/lib/loss-classifier.js) reads
      // `competitor_price` (flat COMPETITOR_PRICE_KEYS), and pairs it with
      // our `quoted_price` for the delta evidence.
      payload.competitor_price = Math.round(product.price * 0.93 * 100) / 100;
    }
    if (outcome === 'STOCK_OUTAGE') {
      payload.requested_variant = 'XL';
      payload.variant_available = false;
    }

    probes.push({ path: '/shipping_quote', method: 'POST', payload, status: 200 });
  }

  return {
    token,
    protocol,
    sku: product.sku,
    price: product.price,
    outcome,
    converts,
    probes,
    orderTotal: converts ? product.price.toFixed(2) : null,
  };
}
