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
  'event_id',
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
 * Merchant resolution for TELEMETRY records (routes/telemetry.js).
 *
 * The edge records shop_domain = the resolved ORIGIN hostname, while
 * shopify_shop_domain holds the *.myshopify.com key Shopify uses on
 * webhooks/OAuth. For custom-domain merchants (origin_url points at their
 * primary storefront domain — the standard production setup) the two differ,
 * so telemetry must match EITHER: the myshopify domain (merchants whose
 * origin IS their myshopify storefront) or origin_hostname (migration 0011,
 * generated from origin_url).
 *
 * Webhooks deliberately do NOT use this lookup: their identity is the
 * HMAC-verified Shopify header, and widening that key would let a
 * misconfigured origin_url capture another merchant's orders.
 *
 * ORDER BY prefers the exact shop-domain match if both somehow hit (e.g. an
 * operator pointed merchant B's origin_url at merchant A's myshopify domain).
 * Both predicates are index-backed (0002 functional unique + 0011 partial).
 *
 * @returns {Promise<{id: string, shopify_shop_domain: string}|null>}
 */
export async function findMerchantForTelemetry(db, hostname) {
  const result = await db.query(
    `SELECT id, shopify_shop_domain
       FROM merchant_profiles
      WHERE lower(shopify_shop_domain) = lower($1)
         OR origin_hostname = lower($1)
      ORDER BY (lower(shopify_shop_domain) = lower($1)) DESC
      LIMIT 1`,
    [hostname]
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
    params.push(
      row.merchantId, row.token, row.protocol, row.method, row.path, row.targetSku, payloadJson,
      row.eventId ?? null, index
    );
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
      `$${base + 8}::uuid, now() + make_interval(secs => $${base + 9}::float8 / 1e6))`
    );
  });

  // ON CONFLICT against the partial unique event_id index (migration 0009):
  // Cloudflare Queues redelivers batches at least once, and the edge stamps
  // event_id BEFORE queue.send — so a redelivered record carries the same id
  // and lands here as a silent no-op instead of double-counting the intent.
  // Rows with NULL event_id (pre-0009 edge builds) never match the partial
  // index and insert exactly as before.
  const result = await db.query(
    `INSERT INTO agent_intent_logs (${INTENT_LOG_COLUMNS.join(', ')}, processed_at)
     VALUES ${valueGroups.join(', ')}
     ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING`,
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
  // The anonymous sentinel is shared by EVERY un-tokenized agent — stitching
  // an order to "the latest anonymous intent" would attribute it to an
  // arbitrary unrelated session. Such orders reconcile on the token alone.
  if (transactionToken === 'headless_anonymous') return null;
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
export async function insertReconciledOrder(db, { merchantId, intentLogId, shopifyOrderId, transactionToken, gmv, currency = null }) {
  const insert = async (intentId) => db.query(
    `INSERT INTO reconciled_agent_orders
        (merchant_id, intent_log_id, shopify_order_id, transaction_token, gross_merchandise_value, currency)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (shopify_order_id) DO NOTHING
     RETURNING id, commission_fee, commission_rate, reconciled_at`,
    [merchantId, intentId, shopifyOrderId, transactionToken, gmv, currency]
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
 * Record one billing credit (refund/cancellation) against a reconciled order.
 *
 * Ledger write, never an UPDATE: the charge row stays immutable and
 * statements net charges minus credits (see db migration 0008).
 *
 * Runs on ONE pinned client inside an explicit transaction because the
 * over-credit clamp is read-modify-write: SELECT the parent FOR UPDATE,
 * sum existing credits, then insert LEAST(requested, remaining). Without the
 * row lock two concurrent webhooks (refund + cancellation racing) could both
 * read the same "remaining" and credit more than the order ever billed.
 * READ COMMITTED + FOR UPDATE is sufficient: the second transaction blocks on
 * the parent lock and its later statements see the winner's committed credit.
 *
 * All money arithmetic happens IN SQL on NUMERIC — requested/remaining never
 * transit JS floats.
 *
 * @param {object} db  must be the real src/db.js wrapper (withClient).
 * @param {{merchantId: string, shopifyOrderId: string, sourceEventId: string,
 *   kind: 'REFUND'|'CANCELLATION', requestedGmv: string|null,
 *   requestedCurrency?: string|null}} adjustment
 *   requestedGmv is a decimal string ("19.90"); null means "everything still
 *   creditable" (the cancellation path). requestedCurrency (when known) must
 *   match the charged order's currency — crediting a presentment-currency
 *   refund amount against shop-currency GMV would be silent wrong math, so a
 *   mismatch is refused loudly instead ('currency_mismatch').
 * @returns {Promise<{status: 'credited'|'duplicate'|'order_not_found'|'nothing_remaining'|'currency_mismatch',
 *   row: object|null}>}
 */
export async function insertOrderAdjustment(db, { merchantId, shopifyOrderId, sourceEventId, kind, requestedGmv, requestedCurrency = null }) {
  return db.withClient(async (query) => {
    try {
      await query('BEGIN');

      // Lock the charge row: serializes concurrent adjustments per order.
      const parentResult = await query(
        `SELECT id, commission_rate, gross_merchandise_value, currency
           FROM reconciled_agent_orders
          WHERE merchant_id = $1 AND shopify_order_id = $2
          FOR UPDATE`,
        [merchantId, shopifyOrderId]
      );
      const parent = parentResult.rows[0];
      if (!parent) {
        // The order's own webhook has not arrived yet (Shopify does not
        // order deliveries across topics) OR it was never agent-attributed.
        // The caller parks the credit in order_adjustment_orphans and
        // replays it if/when the order reconciles.
        await query('ROLLBACK');
        return { status: 'order_not_found', row: null };
      }

      if (
        requestedCurrency !== null &&
        parent.currency !== null &&
        requestedCurrency !== parent.currency
      ) {
        // Never net across currencies. Visible refusal beats silent wrong
        // arithmetic; the operator reconciles this one by hand.
        await query('ROLLBACK');
        return { status: 'currency_mismatch', row: null };
      }

      // Clamp + insert in one statement; NUMERIC arithmetic only. COALESCE
      // of a NULL request means "credit the full remainder" (cancellation).
      const insertResult = await query(
        `WITH already AS (
            SELECT COALESCE(sum(adjusted_gmv), 0)::numeric(12,2) AS total
              FROM order_adjustments
             WHERE reconciled_order_id = $2
         )
         INSERT INTO order_adjustments
            (merchant_id, reconciled_order_id, source_event_id, adjustment_kind,
             adjusted_gmv, commission_rate)
         SELECT $1, $2, $3, $4,
                LEAST(COALESCE($5::numeric(12,2), $6::numeric(12,2) - already.total),
                      $6::numeric(12,2) - already.total),
                $7
           FROM already
          WHERE $6::numeric(12,2) - already.total > 0
            AND COALESCE($5::numeric(12,2), $6::numeric(12,2) - already.total) > 0
         ON CONFLICT (source_event_id) DO NOTHING
         RETURNING id, adjusted_gmv, commission_credit, commission_rate, adjusted_at`,
        [
          merchantId,
          parent.id,
          sourceEventId,
          kind,
          requestedGmv,
          parent.gross_merchandise_value,
          parent.commission_rate,
        ]
      );

      if ((insertResult.rowCount ?? 0) > 0) {
        await query('COMMIT');
        return { status: 'credited', row: insertResult.rows[0] };
      }

      // Zero rows: either the idempotency key already exists (webhook
      // redelivery) or the order is already fully credited. Distinguish for
      // honest logging; both are terminal no-ops for the caller.
      const dup = await query(
        `SELECT 1 FROM order_adjustments WHERE source_event_id = $1`,
        [sourceEventId]
      );
      await query('COMMIT');
      return { status: (dup.rowCount ?? 0) > 0 ? 'duplicate' : 'nothing_remaining', row: null };
    } catch (err) {
      // Roll back best-effort; the original error is the one that matters.
      try {
        await query('ROLLBACK');
      } catch {
        /* connection-level failure — release() discards the client */
      }
      throw err;
    }
  });
}

/**
 * Lightweight order presence probe for the orphan-replay protocol: is this
 * Shopify order reconciled yet, and which intent (if any) is it stitched to?
 * @returns {Promise<{id: string, intent_log_id: string|null}|null>}
 */
export async function findReconciledOrderByShopifyId(db, { merchantId, shopifyOrderId }) {
  const result = await db.query(
    `SELECT id, intent_log_id
       FROM reconciled_agent_orders
      WHERE merchant_id = $1 AND shopify_order_id = $2
      LIMIT 1`,
    [merchantId, shopifyOrderId]
  );
  return result.rows[0] ?? null;
}

/**
 * Park a credit whose order has not been reconciled yet (migration 0012).
 * ON CONFLICT: webhook redelivery of an already-parked credit is a no-op.
 * @returns {Promise<{inserted: boolean}>}
 */
export async function insertAdjustmentOrphan(
  db,
  { merchantId, shopifyOrderId, sourceEventId, kind, requestedGmv, requestedCurrency }
) {
  const result = await db.query(
    `INSERT INTO order_adjustment_orphans
        (merchant_id, shopify_order_id, source_event_id, adjustment_kind,
         requested_gmv, requested_currency)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_event_id) DO NOTHING`,
    [merchantId, shopifyOrderId, sourceEventId, kind, requestedGmv, requestedCurrency]
  );
  return { inserted: (result.rowCount ?? 0) > 0 };
}

/**
 * Orphans waiting on one order, oldest first (replay order matters: partial
 * refunds should consume the clamp before a trailing cancellation).
 */
export async function findAdjustmentOrphansForOrder(db, { merchantId, shopifyOrderId }) {
  const result = await db.query(
    `SELECT id, source_event_id, adjustment_kind, requested_gmv, requested_currency
       FROM order_adjustment_orphans
      WHERE merchant_id = $1 AND shopify_order_id = $2
      ORDER BY received_at ASC`,
    [merchantId, shopifyOrderId]
  );
  return result.rows;
}

/** Remove a replayed (or terminally refused) orphan. */
export async function deleteAdjustmentOrphan(db, orphanId) {
  await db.query(`DELETE FROM order_adjustment_orphans WHERE id = $1`, [orphanId]);
}

/**
 * Reverse the false LOST verdict when an intent converts AFTER the expiry
 * window (slow human-assisted checkout, delayed webhook): the sweep already
 * wrote a loss_diagnostics row, and leaving it makes every slow conversion
 * permanently double-counted as both LOST and WON in every aggregate.
 * Called by the webhook flow right after a successful reconciliation.
 * @returns {Promise<{deleted: number}>}
 */
export async function deleteLossDiagnosticForIntent(db, intentLogId) {
  if (intentLogId === null || intentLogId === undefined) return { deleted: 0 };
  const result = await db.query(
    `DELETE FROM loss_diagnostics WHERE intent_log_id = $1`,
    [intentLogId]
  );
  return { deleted: result.rowCount ?? 0 };
}

/**
 * The sweep query: intents whose conversion window has expired and that
 * neither converted nor were already diagnosed.
 *
 * Anti-join construction (NOT EXISTS x4, all index-backed):
 *   - no reconciled order referencing the intent row directly (intent_log_id),
 *   - no reconciled order matching the intent's token FOR THE SAME MERCHANT
 *     (token matching is how late webhooks reconcile; merchant scoping stops
 *     the shared anonymous sentinel from suppressing other tenants' losses).
 *     SKIPPED for the anonymous sentinel: 'headless_anonymous' is shared by
 *     every un-tokenized agent, so a single sentinel order would otherwise
 *     suppress ALL anonymous drop-offs for that merchant forever,
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
 *     one winner per token either way. ALSO skipped for the anonymous
 *     sentinel — distinct anonymous agents are not one session, and under
 *     steady traffic there is always a newer sentinel row, which would
 *     defer every anonymous diagnosis forever.
 *
 * Watermark bound (sweep_state, migration 0012): the anti-joins exclude
 * already-diagnosed rows from the RESULT, but without a lower bound the scan
 * still VISITS the whole retention window oldest-first on every tick — at
 * firehose scale that outgrows statement_timeout and the sweep dies. The
 * caller passes the persisted watermark; rows below it are already fully
 * processed (diagnosed, reconciled, or skipped-with-error and retried before
 * the watermark advanced — see jobs/loss-sweep.js advancement rules).
 *
 * make_interval(secs => $1) keeps the expiry window parameterized — no
 * interval string concatenation.
 *
 * Oldest-first ORDER BY: under backlog, diagnose the longest-overdue intents
 * before the batch LIMIT cuts off, so no intent starves indefinitely.
 *
 * @param {object} db
 * @param {{expirySeconds: number, limit: number, watermark?: string|null}} options
 *   watermark: ISO timestamp lower bound (inclusive); null scans from the start.
 * @returns {Promise<object[]>} expired, unreconciled, undiagnosed intent rows.
 */
export async function findExpiredUnreconciledIntents(db, { expirySeconds, limit, watermark = null }) {
  const result = await db.query(
    `SELECT i.id, i.merchant_id, i.transaction_token, i.protocol_type,
            i.request_method, i.endpoint_path, i.target_sku, i.inbound_payload,
            i.processed_at
       FROM agent_intent_logs i
      WHERE i.processed_at < now() - make_interval(secs => $1)
        AND ($3::timestamptz IS NULL OR i.processed_at >= $3::timestamptz)
        AND NOT EXISTS (
              SELECT 1 FROM reconciled_agent_orders r
               WHERE r.intent_log_id = i.id)
        AND (i.transaction_token = 'headless_anonymous' OR NOT EXISTS (
              SELECT 1 FROM reconciled_agent_orders r
               WHERE r.transaction_token = i.transaction_token
                 AND r.merchant_id = i.merchant_id))
        AND NOT EXISTS (
              SELECT 1 FROM loss_diagnostics d
               WHERE d.intent_log_id = i.id)
        AND (i.transaction_token = 'headless_anonymous' OR NOT EXISTS (
              SELECT 1 FROM agent_intent_logs newer
               WHERE newer.merchant_id = i.merchant_id
                 AND newer.transaction_token = i.transaction_token
                 AND (newer.processed_at, newer.id) > (i.processed_at, i.id)))
      ORDER BY i.processed_at ASC
      LIMIT $2`,
    [expirySeconds, limit, watermark]
  );
  return result.rows;
}

/**
 * The DB's own view of the sweep frontier (now() - expiry), captured BEFORE
 * a sweep fetch. Using the DATABASE clock for both the eligibility predicate
 * and the drained-frontier watermark removes app-vs-DB clock skew from the
 * safety argument entirely (the 60s read slack then only has to cover batch
 * micro-offsets), and capturing it PRE-fetch means rows becoming eligible
 * during a slow pass stay above the watermark for the next tick.
 * @returns {Promise<string>} ISO timestamp.
 */
export async function getSweepFrontier(db, expirySeconds) {
  const result = await db.query(
    `SELECT (now() - make_interval(secs => $1))::timestamptz AS frontier`,
    [expirySeconds]
  );
  const value = result.rows[0].frontier;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Sweep watermark persistence (sweep_state, migration 0012).
 * getSweepWatermark returns the ISO watermark or null (first run).
 */
export async function getSweepWatermark(db, jobName) {
  const result = await db.query(
    `SELECT watermark FROM sweep_state WHERE job_name = $1`,
    [jobName]
  );
  return result.rows[0]?.watermark ?? null;
}

/**
 * Advance (never regress) a job's watermark. GREATEST keeps a stale replica
 * from moving the frontier backwards.
 */
export async function setSweepWatermark(db, jobName, watermark) {
  await db.query(
    `INSERT INTO sweep_state (job_name, watermark)
     VALUES ($1, $2)
     ON CONFLICT (job_name)
     DO UPDATE SET watermark = GREATEST(sweep_state.watermark, EXCLUDED.watermark),
                   updated_at = now()`,
    [jobName, watermark]
  );
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
  // INSERT..SELECT..WHERE NOT EXISTS re-asserts non-reconciliation AT WRITE
  // TIME: the sweep's eligibility anti-joins ran at FETCH time, and an order
  // reconciling in between (whose reversal DELETE ran before this insert)
  // would otherwise leave a false LOST verdict that nothing ever reverses.
  // Token-based suppression mirrors the fetch query, including the anonymous
  // sentinel exemption.
  const result = await db.query(
    `INSERT INTO loss_diagnostics
        (merchant_id, intent_log_id, target_sku, calculated_loss_reason,
         estimated_revenue_lost, competitor_delta_payload)
     SELECT $1, $2, $3, $4, $5, $6::jsonb
      WHERE NOT EXISTS (
              SELECT 1 FROM reconciled_agent_orders r WHERE r.intent_log_id = $2)
        AND NOT EXISTS (
              SELECT 1 FROM reconciled_agent_orders r
                JOIN agent_intent_logs i ON i.id = $2
               WHERE r.merchant_id = $1
                 AND i.transaction_token <> 'headless_anonymous'
                 AND r.transaction_token = i.transaction_token)
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
 * Counts are currency-free scalars. MONEY is reported per currency
 * (`currencies[]`, mirroring the billing statement's contract from migration
 * 0010): a EUR order and a USD order must never sum into one number, so no
 * cross-currency scalar totals exist in this response at all. Net figures
 * are subtracted in SQL (NUMERIC — money never floats in JS).
 * estimated_losses stays a scalar because loss estimates are heuristic cents
 * derived from agent payloads with no currency evidence; consumers render it
 * as an unlabeled number, never with a currency symbol.
 *
 * @param {object} db
 * @param {{windowDays: number}} options
 * @returns {Promise<{impressions: number, orders_won: number,
 *   adjustments: number, losses: number, estimated_losses: string,
 *   currencies: Array<{currency: string, orders: number, gmv: string,
 *     commission: string, adjustments: number, adjusted_gmv: string,
 *     commission_credits: string, net_gmv: string, net_commission: string}>}>}
 */
export async function getAnalyticsSummary(db, { windowDays }) {
  const [counts, money] = await Promise.all([
    db.query(
      `SELECT
         (SELECT count(*) FROM agent_intent_logs
           WHERE processed_at >= now() - make_interval(days => $1))            AS impressions,
         (SELECT count(*) FROM reconciled_agent_orders
           WHERE reconciled_at >= now() - make_interval(days => $1))           AS orders_won,
         (SELECT count(*) FROM order_adjustments
           WHERE adjusted_at >= now() - make_interval(days => $1))             AS adjustments,
         (SELECT count(*) FROM loss_diagnostics
           WHERE created_at >= now() - make_interval(days => $1))              AS losses,
         (SELECT COALESCE(sum(estimated_revenue_lost), 0) FROM loss_diagnostics
           WHERE created_at >= now() - make_interval(days => $1))              AS estimated_losses`,
      [windowDays]
    ),
    // Charges and credits per currency, FULL OUTER JOINed exactly like the
    // billing statement (a window can be credits-only for a currency).
    db.query(
      `WITH charges AS (
          SELECT COALESCE(currency, 'UNSPECIFIED') AS currency,
                 count(*)::bigint AS orders,
                 sum(gross_merchandise_value) AS gmv,
                 sum(commission_fee) AS commission
            FROM reconciled_agent_orders
           WHERE reconciled_at >= now() - make_interval(days => $1)
           GROUP BY COALESCE(currency, 'UNSPECIFIED')
       ),
       credits AS (
          -- Per-order lifetime clamp, same construction as the billing
          -- statement: recognized credits can never exceed the order's fee
          -- even when per-adjustment rounding sums past it.
          SELECT oc.currency,
                 sum(oc.win_count)::bigint AS adjustments,
                 sum(oc.win_gmv) AS adjusted_gmv,
                 sum(LEAST(oc.total_credit, oc.commission_fee)
                     - LEAST(oc.prior_credit, oc.commission_fee)) AS commission_credits
            FROM (
              SELECT r.id, COALESCE(r.currency, 'UNSPECIFIED') AS currency, r.commission_fee,
                     count(*) FILTER (WHERE a.adjusted_at >= now() - make_interval(days => $1)) AS win_count,
                     COALESCE(sum(a.adjusted_gmv) FILTER (WHERE a.adjusted_at >= now() - make_interval(days => $1)), 0) AS win_gmv,
                     COALESCE(sum(a.commission_credit), 0) AS total_credit,
                     COALESCE(sum(a.commission_credit) FILTER (WHERE a.adjusted_at < now() - make_interval(days => $1)), 0) AS prior_credit
                FROM order_adjustments a
                JOIN reconciled_agent_orders r ON r.id = a.reconciled_order_id
               -- Bound the scan to orders that actually have an in-window
               -- adjustment (index probe on adjusted_at) BEFORE computing
               -- their lifetime totals — without this the CTE re-aggregates
               -- the entire historical ledger on every dashboard poll.
               WHERE a.reconciled_order_id IN (
                       SELECT DISTINCT w.reconciled_order_id FROM order_adjustments w
                        WHERE w.adjusted_at >= now() - make_interval(days => $1))
               GROUP BY r.id, COALESCE(r.currency, 'UNSPECIFIED'), r.commission_fee
              HAVING count(*) FILTER (WHERE a.adjusted_at >= now() - make_interval(days => $1)) > 0
            ) oc
           GROUP BY oc.currency
       )
       SELECT COALESCE(c.currency, cr.currency) AS currency,
              COALESCE(c.orders, 0) AS orders,
              COALESCE(c.gmv, 0) AS gmv,
              COALESCE(c.commission, 0) AS commission,
              COALESCE(cr.adjustments, 0) AS adjustments,
              COALESCE(cr.adjusted_gmv, 0) AS adjusted_gmv,
              COALESCE(cr.commission_credits, 0) AS commission_credits,
              (COALESCE(c.gmv, 0) - COALESCE(cr.adjusted_gmv, 0)) AS net_gmv,
              (COALESCE(c.commission, 0) - COALESCE(cr.commission_credits, 0)) AS net_commission
         FROM charges c
         FULL OUTER JOIN credits cr ON cr.currency = c.currency
        ORDER BY COALESCE(c.gmv, 0) DESC`,
      [windowDays]
    ),
  ]);
  const row = counts.rows[0];
  return {
    impressions: Number(row.impressions),
    orders_won: Number(row.orders_won),
    adjustments: Number(row.adjustments),
    losses: Number(row.losses),
    estimated_losses: String(row.estimated_losses),
    currencies: money.rows.map((r) => ({
      currency: r.currency,
      orders: Number(r.orders),
      gmv: String(r.gmv),
      commission: String(r.commission),
      adjustments: Number(r.adjustments),
      adjusted_gmv: String(r.adjusted_gmv),
      commission_credits: String(r.commission_credits),
      net_gmv: String(r.net_gmv),
      net_commission: String(r.net_commission),
    })),
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
  // currency: WON rows carry the reconciled order's ISO code (migration
  // 0010); LOST rows carry NULL — loss estimates are heuristic cents with no
  // currency evidence, and labeling them would be fabrication. The dashboard
  // renders NULL/unknown as a plain unlabeled number.
  const result = await db.query(
    `SELECT * FROM (
        SELECT d.created_at                        AS occurred_at,
               'LOST'                              AS outcome,
               COALESCE(i.protocol_type, 'UNKNOWN_PROTOCOL') AS protocol,
               d.target_sku                        AS target_sku,
               d.calculated_loss_reason            AS detail,
               d.estimated_revenue_lost::text      AS amount,
               NULL::text                          AS currency
          FROM loss_diagnostics d
          LEFT JOIN agent_intent_logs i ON i.id = d.intent_log_id
        UNION ALL
        SELECT r.reconciled_at                     AS occurred_at,
               'WON'                               AS outcome,
               COALESCE(i.protocol_type, 'UNKNOWN_PROTOCOL') AS protocol,
               COALESCE(i.target_sku, 'UNSPECIFIED') AS target_sku,
               'RECONCILED_ORDER'                  AS detail,
               r.gross_merchandise_value::text     AS amount,
               r.currency::text                    AS currency
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
 * Nets the two ledgers per merchant PER CURRENCY (migration 0010: EUR and
 * USD lines never sum together; legacy NULL currency renders UNSPECIFIED):
 *   - charges: reconciled_agent_orders in the statement month (schema-
 *     generated commission_fee — the billing source of truth),
 *   - credits: order_adjustments whose adjustment happened in the statement
 *     month, joined to their parent order for the currency. A January order
 *     refunded in February credits February's statement (credits follow the
 *     adjustment date, matching when the fee was actually collected).
 * FULL OUTER JOIN: a month can be credits-only (order charged last month,
 * refunded this month, no new orders) and must still produce a line.
 *
 * Month bound is a 'YYYY-MM-01' string cast to date; half-open interval so
 * month boundaries never double-count.
 */
export async function getBillingStatement(db, { monthStartDate }) {
  // Month bounds pinned to UTC explicitly: comparing a timestamptz against a
  // bare ::date resolves through the SERVER's TimeZone setting, silently
  // shifting statement boundaries (and disagreeing with the UTC month label
  // and the dashboard's UTC picker) on any non-UTC server.
  //
  // Credits clamp per ORDER, lifetime-aware: per-adjustment rounding of
  // commission_credit can sum past the order's charged commission_fee (the
  // GMV clamp bounds gmv, not rounded fees). Each order's credit recognized
  // in this month is LEAST(lifetime credits, fee) minus what was already
  // recognized before the month — total recognized credits can never exceed
  // the fee, across any refund/cancel split over any months.
  const result = await db.query(
    `WITH bounds AS (
        SELECT ($1::date::timestamp AT TIME ZONE 'UTC') AS month_start,
               (($1::date + interval '1 month')::timestamp AT TIME ZONE 'UTC') AS month_end
     ),
     charges AS (
        SELECT r.merchant_id,
               COALESCE(r.currency, 'UNSPECIFIED') AS currency,
               count(*)::bigint AS orders,
               sum(r.gross_merchandise_value) AS gmv,
               sum(r.commission_fee) AS commission,
               -- rate snapshots can differ across rows after a rate change;
               -- surface the range so statements stay explainable.
               min(r.commission_rate) AS min_rate,
               max(r.commission_rate) AS max_rate
          FROM reconciled_agent_orders r, bounds b
         WHERE r.reconciled_at >= b.month_start
           AND r.reconciled_at < b.month_end
         GROUP BY r.merchant_id, COALESCE(r.currency, 'UNSPECIFIED')
     ),
     credits AS (
        SELECT oc.merchant_id,
               COALESCE(oc.currency, 'UNSPECIFIED') AS currency,
               sum(oc.month_count)::bigint AS adjustments,
               sum(oc.month_gmv) AS adjusted_gmv,
               sum(LEAST(oc.total_credit, oc.commission_fee)
                   - LEAST(oc.prior_credit, oc.commission_fee)) AS commission_credits
          FROM (
            SELECT r.id, r.merchant_id, r.currency, r.commission_fee,
                   count(*) FILTER (WHERE a.adjusted_at >= b.month_start) AS month_count,
                   COALESCE(sum(a.adjusted_gmv) FILTER (WHERE a.adjusted_at >= b.month_start), 0) AS month_gmv,
                   COALESCE(sum(a.commission_credit), 0) AS total_credit,
                   COALESCE(sum(a.commission_credit) FILTER (WHERE a.adjusted_at < b.month_start), 0) AS prior_credit
              FROM order_adjustments a
              JOIN reconciled_agent_orders r ON r.id = a.reconciled_order_id
              CROSS JOIN bounds b
             -- Same in-window pre-filter as the summary CTE: only orders with
             -- an adjustment in the statement month need lifetime totals.
             WHERE a.adjusted_at < b.month_end
               AND a.reconciled_order_id IN (
                     SELECT DISTINCT w.reconciled_order_id FROM order_adjustments w, bounds wb
                      WHERE w.adjusted_at >= wb.month_start AND w.adjusted_at < wb.month_end)
             GROUP BY r.id, r.merchant_id, r.currency, r.commission_fee, b.month_start
            HAVING count(*) FILTER (WHERE a.adjusted_at >= b.month_start) > 0
          ) oc
         GROUP BY oc.merchant_id, COALESCE(oc.currency, 'UNSPECIFIED')
     )
     SELECT m.id AS merchant_id,
            m.shopify_shop_domain,
            COALESCE(c.currency, cr.currency) AS currency,
            COALESCE(c.orders, 0) AS orders,
            COALESCE(c.gmv, 0) AS gmv,
            COALESCE(c.commission, 0) AS commission,
            COALESCE(cr.adjustments, 0) AS adjustments,
            COALESCE(cr.adjusted_gmv, 0) AS adjusted_gmv,
            COALESCE(cr.commission_credits, 0) AS commission_credits,
            (COALESCE(c.gmv, 0) - COALESCE(cr.adjusted_gmv, 0)) AS net_gmv,
            (COALESCE(c.commission, 0) - COALESCE(cr.commission_credits, 0)) AS net_commission,
            c.min_rate AS min_rate,
            c.max_rate AS max_rate
       FROM charges c
       FULL OUTER JOIN credits cr
         ON cr.merchant_id = c.merchant_id AND cr.currency = c.currency
       JOIN merchant_profiles m ON m.id = COALESCE(c.merchant_id, cr.merchant_id)
      ORDER BY (COALESCE(c.commission, 0) - COALESCE(cr.commission_credits, 0)) DESC`,
    [monthStartDate]
  );
  return result.rows.map((row) => ({
    merchant_id: row.merchant_id,
    shop_domain: row.shopify_shop_domain,
    currency: row.currency,
    orders: Number(row.orders),
    gmv: String(row.gmv),
    commission: String(row.commission),
    adjustments: Number(row.adjustments),
    adjusted_gmv: String(row.adjusted_gmv),
    commission_credits: String(row.commission_credits),
    net_gmv: String(row.net_gmv),
    net_commission: String(row.net_commission),
    // NULL on credits-only lines (no charges this month to snapshot from).
    min_rate: row.min_rate === null ? null : String(row.min_rate),
    max_rate: row.max_rate === null ? null : String(row.max_rate),
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
          -- The sentinel is not a product: a reprice worklist entry named
          -- UNSPECIFIED is unactionable noise (traffic top-SKUs filters it
          -- the same way).
          AND target_sku <> 'UNSPECIFIED'
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
