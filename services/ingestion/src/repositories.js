/**
 * repositories.js — ALL SQL for the AOP ingestion service lives in this file.
 *
 * Role in the AOP data flow:
 *   The single data-access seam between the HTTP/job layers and PostgreSQL:
 *     - telemetry ingest  -> findMerchantByShopDomain + insertIntentLogsBatch
 *     - webhook stitch    -> findLatestIntentByToken + insertReconciledOrder
 *     - loss sweep        -> findExpiredUnreconciledIntents + insertLossDiagnostic
 *   Keeping every statement here (and nowhere else) makes the injection
 *   surface auditable in one read: EVERY statement is strictly parameterized
 *   ($1..$n) — no string interpolation of values, ever. The only dynamically
 *   built SQL is the VALUES placeholder list for the batch insert, which
 *   interpolates generated "$<number>" tokens only, never data.
 *
 * All functions take the db wrapper (src/db.js) as their first argument —
 * dependency injection keeps this module import-clean for unit testing and
 * keeps transaction/pool policy out of the SQL layer.
 */

/** Columns inserted per intent-log row; order must match buildIntentLogParams. */
const INTENT_LOG_COLUMNS = [
  'merchant_id',
  'transaction_token',
  'protocol_type',
  'request_method',
  'endpoint_path',
  'target_sku',
  'inbound_payload',
];

/**
 * Resolve a merchant by shop domain, case-insensitively.
 *
 * lower() on BOTH sides deliberately matches the functional unique index
 * merchant_profiles_shop_domain_lower_uidx (db migration 0002), so this is an
 * index lookup, not a scan — this query is on the ingest hot path via the
 * telemetry route's TTL cache misses and on every webhook.
 *
 * @returns {Promise<{id: string, shopify_shop_domain: string}|null>}
 */
export async function findMerchantByShopDomain(db, shopDomain) {
  const result = await db.query(
    `SELECT id, shopify_shop_domain
       FROM merchant_profiles
      WHERE lower(shopify_shop_domain) = lower($1)
      LIMIT 1`,
    [shopDomain]
  );
  return result.rows[0] ?? null;
}

/**
 * Batch-insert intent logs as ONE multi-row INSERT.
 *
 * A single statement (vs N inserts) is what keeps the firehose cheap: one
 * network round-trip, one WAL flush. Placeholders are strictly numbered and
 * generated ($1..$n) — the SQL text never contains row data.
 *
 * @param {object} db
 * @param {Array<{merchantId: string, token: string, protocol: string,
 *   method: string, path: string, targetSku: string, payload: object|null}>} rows
 *   pre-validated rows (src/lib/validate-telemetry.js output + resolved merchant).
 * @returns {Promise<number>} number of rows inserted.
 */
export async function insertIntentLogsBatch(db, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const params = [];
  const valueGroups = rows.map((row, index) => {
    // Payload is stringified HERE (not left to the driver): node-postgres
    // would serialize a JS array parameter as a Postgres array literal, not
    // JSON — the explicit ::jsonb cast on a JSON string is unambiguous.
    const payloadJson = row.payload === null || row.payload === undefined ? null : JSON.stringify(row.payload);
    params.push(row.merchantId, row.token, row.protocol, row.method, row.path, row.targetSku, payloadJson, index);
    const base = params.length - (INTENT_LOG_COLUMNS.length + 1);
    // Placeholders only. processed_at = now() + batch-position microseconds:
    // every row of a multi-row INSERT shares the transaction's now(), which
    // would make same-token probes in one batch (availability then
    // shipping_quote) mutually "not newer" — the loss sweep and attribution
    // stitch both order by processed_at, and "which probe came last" must
    // follow queue arrival order, not a random-UUID tie-break. One µs per
    // position is far below any real inter-probe gap and preserves order.
    return (
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb, ` +
      `now() + make_interval(secs => $${base + 8}::float8 / 1e6))`
    );
  });

  const result = await db.query(
    `INSERT INTO agent_intent_logs (${INTENT_LOG_COLUMNS.join(', ')}, processed_at)
     VALUES ${valueGroups.join(', ')}`,
    params
  );
  return result.rowCount ?? 0;
}

/**
 * The attribution stitch: newest intent row carrying this transaction token
 * for this merchant. Newest-first because one token legitimately spans
 * several probes (/availability then /shipping_quote) — the LAST touch before
 * checkout is the attribution-winning intent.
 *
 * Scoped by merchant_id (not token alone): tokens are minted at the edge and
 * *should* be globally unique, but the anonymous sentinel and buggy agents
 * are not, and a cross-tenant token collision must never leak another
 * merchant's intent row into this merchant's attribution.
 *
 * UNCLAIMED intents only: reconciled_agent_orders.intent_log_id is UNIQUE
 * (one order per intent, db migration 0004), so an intent already credited
 * with an order must not be offered to a second order sharing the token
 * (token reuse by buggy agents / the anonymous sentinel). The NOT EXISTS is
 * index-backed by that same unique index. A second order therefore stitches
 * to an older unclaimed ping, or reconciles on the token alone (NULL intent).
 *
 * @returns {Promise<object|null>} full intent row or null.
 */
export async function findLatestIntentByToken(db, merchantId, transactionToken) {
  const result = await db.query(
    `SELECT i.id, i.merchant_id, i.transaction_token, i.protocol_type,
            i.request_method, i.endpoint_path, i.target_sku, i.inbound_payload,
            i.processed_at
       FROM agent_intent_logs i
      WHERE i.merchant_id = $1
        AND i.transaction_token = $2
        AND NOT EXISTS (
              SELECT 1 FROM reconciled_agent_orders r
               WHERE r.intent_log_id = i.id)
      ORDER BY i.processed_at DESC, i.id DESC
      LIMIT 1`,
    [merchantId, transactionToken]
  );
  return result.rows[0] ?? null;
}

/**
 * Insert a reconciled (attributed) order.
 *
 * Two invariants live in the SQL on purpose:
 *   - commission_fee is NOT in the column list: it is a STORED GENERATED
 *     column (round(gmv * rate, 2)) — the DATABASE is authoritative for
 *     billing math; supplying it would be an error, and recomputing it in JS
 *     (src/lib/commission.js) is for verification/reporting only.
 *   - ON CONFLICT (shopify_order_id) DO NOTHING: Shopify delivers webhooks
 *     at-least-once; a redelivered order must silently no-op (rowCount 0),
 *     never double-bill a commission.
 *
 * Race fallback: findLatestIntentByToken only offers UNCLAIMED intents, but
 * two concurrent webhooks can still both read the same unclaimed intent and
 * race the UNIQUE(intent_log_id) index — ON CONFLICT can only arbitrate one
 * constraint, so the loser surfaces as a 23505 on the intent index. That
 * exact case is retried ONCE with intent_log_id = NULL (token-alone
 * reconciliation, always legal — the index allows unlimited NULLs). Any
 * other error propagates untouched.
 *
 * @param {object} db
 * @param {{merchantId: string, intentLogId: string|null, shopifyOrderId: string,
 *   transactionToken: string, gmv: string}} order
 *   gmv is a decimal STRING (e.g. "129.90") — money never transits as a float.
 *   intentLogId may be null: a late webhook whose intent row was already
 *   pruned still bills correctly on the token alone (see db migration 0004).
 * @returns {Promise<{inserted: boolean, row: object|null}>}
 *   inserted=false means the conflict path fired (webhook redelivery).
 */
export async function insertReconciledOrder(db, { merchantId, intentLogId, shopifyOrderId, transactionToken, gmv }) {
  const insert = async (intentId) => db.query(
    `INSERT INTO reconciled_agent_orders
        (merchant_id, intent_log_id, shopify_order_id, transaction_token, gross_merchandise_value)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (shopify_order_id) DO NOTHING
     RETURNING id, commission_fee, commission_rate, reconciled_at`,
    [merchantId, intentId, shopifyOrderId, transactionToken, gmv]
  );

  let result;
  try {
    result = await insert(intentLogId ?? null);
  } catch (err) {
    // Lost the one-order-per-intent race (see doc comment): fall back to
    // token-alone reconciliation so the billable order is never dropped.
    const lostIntentRace =
      err?.code === '23505' &&
      typeof err?.constraint === 'string' &&
      err.constraint.includes('intent_log_id') &&
      intentLogId !== null && intentLogId !== undefined;
    if (!lostIntentRace) throw err;
    result = await insert(null);
  }
  return { inserted: (result.rowCount ?? 0) > 0, row: result.rows[0] ?? null };
}

/**
 * The sweep query: intents whose conversion window has expired and that
 * neither converted nor were already diagnosed.
 *
 * Anti-join construction (NOT EXISTS x4, all index-backed):
 *   - no reconciled order referencing the intent row directly (intent_log_id),
 *   - no reconciled order matching the intent's token FOR THE SAME MERCHANT
 *     (token matching is how late webhooks reconcile; merchant scoping stops
 *     the shared anonymous sentinel from suppressing other tenants' losses),
 *   - no existing loss_diagnostics row (idempotency: re-scanning a window
 *     after a crash must not re-fetch already-diagnosed intents; the UNIQUE
 *     constraint on loss_diagnostics.intent_log_id is the schema-level
 *     backstop for the race where two sweeps interleave anyway),
 *   - no NEWER intent with the same token for the same merchant: one agent
 *     session legitimately spans several probes (/availability then
 *     /shipping_quote) under one token, and diagnosing every probe would
 *     double-count a single abandoned session and mis-attribute the
 *     drop-off phase. Only the session's LAST probe — the phase the agent
 *     actually walked away from — earns the diagnostic; earlier probes of a
 *     diagnosed session are never selected (they always fail this check).
 *     Tie-break on (processed_at, id): probes of one session batched into a
 *     single multi-row INSERT share the transaction's now(), so timestamp
 *     alone cannot order them; the row-tuple comparison guarantees exactly
 *     one winner per token either way.
 *
 * make_interval(secs => $1) keeps the expiry window parameterized — no
 * interval string concatenation.
 *
 * Oldest-first ORDER BY: under backlog, diagnose the longest-overdue intents
 * before the batch LIMIT cuts off, so no intent starves indefinitely.
 *
 * @param {object} db
 * @param {{expirySeconds: number, limit: number}} options
 * @returns {Promise<object[]>} expired, unreconciled, undiagnosed intent rows.
 */
export async function findExpiredUnreconciledIntents(db, { expirySeconds, limit }) {
  const result = await db.query(
    `SELECT i.id, i.merchant_id, i.transaction_token, i.protocol_type,
            i.request_method, i.endpoint_path, i.target_sku, i.inbound_payload,
            i.processed_at
       FROM agent_intent_logs i
      WHERE i.processed_at < now() - make_interval(secs => $1)
        AND NOT EXISTS (
              SELECT 1 FROM reconciled_agent_orders r
               WHERE r.intent_log_id = i.id)
        AND NOT EXISTS (
              SELECT 1 FROM reconciled_agent_orders r
               WHERE r.transaction_token = i.transaction_token
                 AND r.merchant_id = i.merchant_id)
        AND NOT EXISTS (
              SELECT 1 FROM loss_diagnostics d
               WHERE d.intent_log_id = i.id)
        AND NOT EXISTS (
              SELECT 1 FROM agent_intent_logs newer
               WHERE newer.merchant_id = i.merchant_id
                 AND newer.transaction_token = i.transaction_token
                 AND (newer.processed_at, newer.id) > (i.processed_at, i.id))
      ORDER BY i.processed_at ASC
      LIMIT $2`,
    [expirySeconds, limit]
  );
  return result.rows;
}

/**
 * Record one loss diagnostic for an expired intent.
 *
 * ON CONFLICT (intent_log_id) DO NOTHING makes the write idempotent against
 * sweep overlap/restart races: the loss_diagnostics UNIQUE constraint
 * guarantees at most one diagnostic per intent, and a lost race is a silent
 * no-op (inserted=false), never an error and never a double-counted loss.
 *
 * @param {object} db
 * @param {{merchantId: string, intentLogId: string, targetSku: string,
 *   reason: string, estimatedRevenueLost: string, competitorDelta: object|null}} diagnostic
 *   estimatedRevenueLost is a decimal STRING ("19.99") — see insertReconciledOrder.
 * @returns {Promise<{inserted: boolean}>}
 */
export async function insertLossDiagnostic(
  db,
  { merchantId, intentLogId, targetSku, reason, estimatedRevenueLost, competitorDelta }
) {
  const deltaJson = competitorDelta === null || competitorDelta === undefined ? null : JSON.stringify(competitorDelta);
  const result = await db.query(
    `INSERT INTO loss_diagnostics
        (merchant_id, intent_log_id, target_sku, calculated_loss_reason,
         estimated_revenue_lost, competitor_delta_payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (intent_log_id) DO NOTHING`,
    [merchantId, intentLogId, targetSku, reason, estimatedRevenueLost, deltaJson]
  );
  return { inserted: (result.rowCount ?? 0) > 0 };
}

// ===========================================================================
// Dashboard analytics reads (routes/analytics.js).
//
// All read-only aggregates for the Loss Diagnosis dashboard. Windows are
// parameterized through make_interval(days => $1) — never interval-string
// concatenation — and every query is bounded (aggregate or LIMIT), so a
// hostile ?days/?limit can at worst scan the clamped retention window.
// ===========================================================================

/**
 * Headline numbers for the dashboard's stat cards, one window in one trip:
 * agent impressions (intent pings), reconciled orders won (+ GMV/commission),
 * and estimated revenue lost. Scalar subqueries instead of joins — the three
 * tables aggregate independently and a join would multiply rows.
 *
 * @param {object} db
 * @param {{windowDays: number}} options
 * @returns {Promise<{impressions: number, orders_won: number, gmv: string,
 *   commission: string, estimated_losses: string, losses: number}>}
 */
export async function getAnalyticsSummary(db, { windowDays }) {
  const result = await db.query(
    `SELECT
       (SELECT count(*) FROM agent_intent_logs
         WHERE processed_at >= now() - make_interval(days => $1))            AS impressions,
       (SELECT count(*) FROM reconciled_agent_orders
         WHERE reconciled_at >= now() - make_interval(days => $1))           AS orders_won,
       (SELECT COALESCE(sum(gross_merchandise_value), 0) FROM reconciled_agent_orders
         WHERE reconciled_at >= now() - make_interval(days => $1))           AS gmv,
       (SELECT COALESCE(sum(commission_fee), 0) FROM reconciled_agent_orders
         WHERE reconciled_at >= now() - make_interval(days => $1))           AS commission,
       (SELECT count(*) FROM loss_diagnostics
         WHERE created_at >= now() - make_interval(days => $1))              AS losses,
       (SELECT COALESCE(sum(estimated_revenue_lost), 0) FROM loss_diagnostics
         WHERE created_at >= now() - make_interval(days => $1))              AS estimated_losses`,
    [windowDays]
  );
  const row = result.rows[0];
  return {
    impressions: Number(row.impressions),
    orders_won: Number(row.orders_won),
    gmv: String(row.gmv),
    commission: String(row.commission),
    losses: Number(row.losses),
    estimated_losses: String(row.estimated_losses),
  };
}

/**
 * "Top reason for lost agent sales": loss counts + revenue by reason,
 * biggest revenue impact first (what the merchant should fix first).
 */
export async function getLossReasonBreakdown(db, { windowDays }) {
  const result = await db.query(
    `SELECT calculated_loss_reason AS reason,
            count(*)::bigint AS count,
            COALESCE(sum(estimated_revenue_lost), 0) AS estimated_revenue_lost
       FROM loss_diagnostics
      WHERE created_at >= now() - make_interval(days => $1)
      GROUP BY calculated_loss_reason
      ORDER BY sum(estimated_revenue_lost) DESC, count(*) DESC`,
    [windowDays]
  );
  return result.rows.map((row) => ({
    reason: row.reason,
    count: Number(row.count),
    estimated_revenue_lost: String(row.estimated_revenue_lost),
  }));
}

/**
 * "Critical drop-off analysis": which endpoint phase the lost intents died
 * in (/availability vs /shipping_quote), via the diagnostic's intent row.
 */
export async function getLossPhaseBreakdown(db, { windowDays }) {
  const result = await db.query(
    `SELECT i.endpoint_path AS phase, count(*)::bigint AS count
       FROM loss_diagnostics d
       JOIN agent_intent_logs i ON i.id = d.intent_log_id
      WHERE d.created_at >= now() - make_interval(days => $1)
      GROUP BY i.endpoint_path
      ORDER BY count(*) DESC`,
    [windowDays]
  );
  return result.rows.map((row) => ({ phase: row.phase, count: Number(row.count) }));
}

/**
 * "Recent loss logs (live stream)": interleaved WON/LOST events, newest
 * first. UNION ALL of the two outcome tables, each joined back to its intent
 * for protocol/SKU context (orders reconciled on token alone fall back to
 * their denormalized fields). The outer ORDER BY + LIMIT bounds the read.
 */
export async function getRecentActivity(db, { limit }) {
  const result = await db.query(
    `SELECT * FROM (
        SELECT d.created_at                        AS occurred_at,
               'LOST'                              AS outcome,
               COALESCE(i.protocol_type, 'UNKNOWN_PROTOCOL') AS protocol,
               d.target_sku                        AS target_sku,
               d.calculated_loss_reason            AS detail,
               d.estimated_revenue_lost::text      AS amount
          FROM loss_diagnostics d
          LEFT JOIN agent_intent_logs i ON i.id = d.intent_log_id
        UNION ALL
        SELECT r.reconciled_at                     AS occurred_at,
               'WON'                               AS outcome,
               COALESCE(i.protocol_type, 'UNKNOWN_PROTOCOL') AS protocol,
               COALESCE(i.target_sku, 'UNSPECIFIED') AS target_sku,
               'RECONCILED_ORDER'                  AS detail,
               r.gross_merchandise_value::text     AS amount
          FROM reconciled_agent_orders r
          LEFT JOIN agent_intent_logs i ON i.id = r.intent_log_id
     ) activity
     ORDER BY occurred_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Merchant onboarding upsert (routes/oauth.js): install or re-install.
 *
 * ON CONFLICT targets the functional unique index on lower(domain)
 * (migration 0002) so 'Shop.myshopify.com' vs 'shop.myshopify.com' hit the
 * same row. A re-install refreshes the encrypted token in place — the
 * merchant id (and every FK pointing at it) is stable across reinstalls.
 *
 * @param {object} db
 * @param {{shopDomain: string, encryptedToken: string}} merchant
 *   shopDomain MUST be pre-validated (normalizeShopDomain); encryptedToken is
 *   lib/token-crypto.js ciphertext — NEVER a plaintext token.
 * @returns {Promise<{id: string, shopify_shop_domain: string}>}
 */
export async function upsertMerchantToken(db, { shopDomain, encryptedToken, proxyHostname = null, originUrl = null }) {
  // Routing columns use COALESCE(existing, new): install supplies sensible
  // defaults (derived proxy hostname, https://<shop domain> origin) but a
  // reinstall must never clobber routing an operator customized by hand.
  const result = await db.query(
    `INSERT INTO merchant_profiles (shopify_shop_domain, access_token_encrypted, proxy_hostname, origin_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ((lower(shopify_shop_domain)))
     DO UPDATE SET access_token_encrypted = EXCLUDED.access_token_encrypted,
                   proxy_hostname = COALESCE(merchant_profiles.proxy_hostname, EXCLUDED.proxy_hostname),
                   origin_url = COALESCE(merchant_profiles.origin_url, EXCLUDED.origin_url),
                   updated_at = now()
     RETURNING id, shopify_shop_domain, proxy_hostname, origin_url`,
    [shopDomain, encryptedToken, proxyHostname, originUrl]
  );
  return result.rows[0];
}

/**
 * Agent Traffic breakdown (routes/analytics.js): protocol share, intent
 * (prompt) categories, and the most-probed SKUs for one window. Three
 * bounded aggregates in one round trip. intent_category lives in the stored
 * JSONB under _edge (Context Reconstruction, lib/intent-classifier.js);
 * rows without a context signal are excluded from that breakdown rather
 * than pollute it with NULL.
 */
export async function getTrafficBreakdown(db, { windowDays }) {
  const [protocols, intents, skus] = await Promise.all([
    db.query(
      `SELECT protocol_type AS protocol, count(*)::bigint AS count
         FROM agent_intent_logs
        WHERE processed_at >= now() - make_interval(days => $1)
        GROUP BY protocol_type
        ORDER BY count(*) DESC`,
      [windowDays]
    ),
    db.query(
      `SELECT inbound_payload->'_edge'->>'intent_category' AS category,
              count(*)::bigint AS count
         FROM agent_intent_logs
        WHERE processed_at >= now() - make_interval(days => $1)
          AND inbound_payload->'_edge'->>'intent_category' IS NOT NULL
        GROUP BY 1
        ORDER BY count(*) DESC`,
      [windowDays]
    ),
    db.query(
      `SELECT target_sku, count(*)::bigint AS probes
         FROM agent_intent_logs
        WHERE processed_at >= now() - make_interval(days => $1)
          AND target_sku <> 'UNSPECIFIED'
        GROUP BY target_sku
        ORDER BY count(*) DESC
        LIMIT 10`,
      [windowDays]
    ),
  ]);
  return {
    protocols: protocols.rows.map((r) => ({ protocol: r.protocol, count: Number(r.count) })),
    intent_categories: intents.rows.map((r) => ({ category: r.category, count: Number(r.count) })),
    top_skus: skus.rows.map((r) => ({ sku: r.target_sku, probes: Number(r.probes) })),
  };
}

/**
 * Monthly commission billing statement (routes/analytics.js).
 *
 * reconciled_agent_orders is the billing source of truth (commission_fee is
 * the schema's generated column) — this query only aggregates it, per
 * merchant, for one calendar month. The month bound is a 'YYYY-MM-01'
 * string cast to date; half-open interval so month boundaries never
 * double-count an order.
 */
export async function getBillingStatement(db, { monthStartDate }) {
  const result = await db.query(
    `SELECT m.id AS merchant_id,
            m.shopify_shop_domain,
            count(*)::bigint AS orders,
            sum(r.gross_merchandise_value) AS gmv,
            sum(r.commission_fee) AS commission,
            -- rate snapshots can differ across rows after a rate change;
            -- surface the range so statements stay explainable.
            min(r.commission_rate) AS min_rate,
            max(r.commission_rate) AS max_rate
       FROM reconciled_agent_orders r
       JOIN merchant_profiles m ON m.id = r.merchant_id
      WHERE r.reconciled_at >= $1::date
        AND r.reconciled_at < ($1::date + interval '1 month')
      GROUP BY m.id, m.shopify_shop_domain
      ORDER BY sum(r.commission_fee) DESC`,
    [monthStartDate]
  );
  return result.rows.map((row) => ({
    merchant_id: row.merchant_id,
    shop_domain: row.shopify_shop_domain,
    orders: Number(row.orders),
    gmv: String(row.gmv),
    commission: String(row.commission),
    min_rate: String(row.min_rate),
    max_rate: String(row.max_rate),
  }));
}

/**
 * Competitive price benchmark (routes/analytics.js — the Benchmark Engine).
 *
 * Source: loss_diagnostics rows with reason PRICE_DISCREPANCY, whose
 * competitor_delta_payload was written by the loss classifier with exact
 * integer-cents evidence ({our_price_cents, competitor_price_cents,
 * delta_cents}). Aggregating that evidence answers the spec's headline
 * question — "how much higher was my price when an agent chose a
 * competitor?" — overall and per SKU (the reprice worklist).
 *
 * Cents arrive as JSONB numbers; aggregates coerce via (->>...)::bigint and
 * guard with IS NOT NULL so legacy/foreign rows without evidence are simply
 * excluded rather than poisoning averages.
 */
export async function getPriceBenchmark(db, { windowDays }) {
  const [overall, bySku] = await Promise.all([
    db.query(
      `SELECT count(*)::bigint AS price_losses,
              COALESCE(sum(estimated_revenue_lost), 0) AS revenue_lost,
              round(avg((competitor_delta_payload->>'delta_cents')::bigint)) AS avg_delta_cents,
              round(avg((competitor_delta_payload->>'our_price_cents')::bigint)) AS avg_our_price_cents,
              round(avg((competitor_delta_payload->>'competitor_price_cents')::bigint)) AS avg_competitor_price_cents
         FROM loss_diagnostics
        WHERE calculated_loss_reason = 'PRICE_DISCREPANCY'
          AND created_at >= now() - make_interval(days => $1)
          AND (competitor_delta_payload->>'delta_cents') IS NOT NULL`,
      [windowDays]
    ),
    db.query(
      `SELECT target_sku,
              count(*)::bigint AS losses,
              round(avg((competitor_delta_payload->>'delta_cents')::bigint)) AS avg_delta_cents,
              round(avg((competitor_delta_payload->>'our_price_cents')::bigint)) AS avg_our_price_cents,
              round(avg((competitor_delta_payload->>'competitor_price_cents')::bigint)) AS avg_competitor_price_cents,
              COALESCE(sum(estimated_revenue_lost), 0) AS revenue_lost
         FROM loss_diagnostics
        WHERE calculated_loss_reason = 'PRICE_DISCREPANCY'
          AND created_at >= now() - make_interval(days => $1)
          AND (competitor_delta_payload->>'delta_cents') IS NOT NULL
        GROUP BY target_sku
        ORDER BY sum(estimated_revenue_lost) DESC
        LIMIT 20`,
      [windowDays]
    ),
  ]);
  const row = overall.rows[0];
  const toNum = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    price_losses: Number(row.price_losses),
    revenue_lost: String(row.revenue_lost),
    avg_delta_cents: toNum(row.avg_delta_cents),
    avg_our_price_cents: toNum(row.avg_our_price_cents),
    avg_competitor_price_cents: toNum(row.avg_competitor_price_cents),
    by_sku: bySku.rows.map((r) => ({
      sku: r.target_sku,
      losses: Number(r.losses),
      avg_delta_cents: toNum(r.avg_delta_cents),
      avg_our_price_cents: toNum(r.avg_our_price_cents),
      avg_competitor_price_cents: toNum(r.avg_competitor_price_cents),
      revenue_lost: String(r.revenue_lost),
    })),
  };
}

/**
 * Dynamic edge routing lookup (routes/routing.js -> edge worker).
 *
 * Answers "which storefront origin serves this proxy hostname?" from the
 * columns OAuth install populates (migration 0007). Case-insensitive via the
 * partial functional unique index; rows without an origin_url are not
 * routable and return null exactly like unknown hostnames.
 *
 * @returns {Promise<{origin: string}|null>}
 */
export async function findRouteByProxyHostname(db, hostname) {
  const result = await db.query(
    `SELECT origin_url
       FROM merchant_profiles
      WHERE proxy_hostname IS NOT NULL
        AND lower(proxy_hostname) = lower($1)
        AND origin_url IS NOT NULL
      LIMIT 1`,
    [hostname]
  );
  return result.rows[0] ? { origin: result.rows[0].origin_url } : null;
}
