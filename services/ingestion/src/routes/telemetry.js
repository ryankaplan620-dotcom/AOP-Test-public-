/**
 * routes/telemetry.js — the Worker Ingestion Engine's HTTP surface.
 *
 * Role in the AOP data flow:
 *   [Cloudflare Worker edge proxy] -> env.EDGE_LOG_QUEUE -> [queue consumer]
 *     --HTTPS POST /ingest/telemetry {records:[...]}--> THIS ROUTE
 *     --> validate (src/lib/validate-telemetry.js)
 *     --> resolve shop_domain -> merchant_id (TTL-cached DB lookup)
 *     --> single multi-row INSERT into agent_intent_logs.
 *
 * Design constraints honored here:
 *   - Bearer auth compared timing-safely (src/lib/auth.js): the queue
 *     consumer is the only legitimate caller.
 *   - Per-record fault isolation: one malformed record is counted and
 *     dropped; it never fails the batch (the edge already shipped these
 *     events — a rejected batch would be data loss on retry exhaustion).
 *   - The response tells the queue consumer exactly what happened:
 *     {inserted, skipped_unknown_merchant, rejected_invalid} — so IT can
 *     decide about DLQ-ing without this service guessing.
 *   - Batch size hard cap (413): the queue consumer batches at ~100; 500 is
 *     generous headroom while bounding worst-case statement size and memory.
 */

import express from 'express';
import { timingSafeTokenCheck } from '../lib/auth.js';
import { validateTelemetryRecord } from '../lib/validate-telemetry.js';
import { findMerchantByShopDomain, insertIntentLogsBatch } from '../repositories.js';

/** Hard ceiling on records per POST — beyond this the caller must split. */
export const MAX_RECORDS_PER_BATCH = 500;

/** Merchant-resolution cache TTL. 60s bounds staleness: a newly onboarded
 * merchant's telemetry flows within a minute; an offboarded merchant's
 * events stop landing within a minute of profile deletion. */
const MERCHANT_CACHE_TTL_MS = 60_000;

/** Cache entry cap — a hostile flood of unique fake domains must not grow
 * memory unboundedly. FIFO eviction (Map preserves insertion order). */
const MERCHANT_CACHE_MAX_ENTRIES = 5_000;

/**
 * Minimal TTL cache. Local to this route on purpose: merchant resolution is
 * the only cached lookup in the service, and keeping the cache next to its
 * single consumer avoids a premature "caching layer".
 */
class TtlCache {
  constructor(ttlMs, maxEntries) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map(); // key -> {value, expiresAt}
  }

  /** @returns {{value: any}|null} wrapped so a cached `null` (negative hit) is distinguishable from a miss. */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return { value: entry.value };
  }

  set(key, value) {
    // Evict oldest first when full; delete-then-set keeps recency in the Map order.
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

/**
 * Build the telemetry router.
 *
 * @param {{config: object, db: object, logger: object}} deps
 * @returns {express.Router}
 */
export function buildTelemetryRouter({ config, db, logger }) {
  const router = express.Router();
  const merchantCache = new TtlCache(MERCHANT_CACHE_TTL_MS, MERCHANT_CACHE_MAX_ENTRIES);

  /**
   * Resolve shop_domain -> merchant row ({id, ...}) or null, via cache.
   * NEGATIVE results are cached too — otherwise a flood of events for an
   * unknown domain (e.g. a merchant mid-offboarding) would hammer PostgreSQL
   * once per record. Keyed lowercase to match the DB's case-insensitive
   * uniqueness.
   */
  async function resolveMerchant(shopDomain) {
    const key = shopDomain.toLowerCase();
    const cached = merchantCache.get(key);
    if (cached !== null) return cached.value;
    const merchant = await findMerchantByShopDomain(db, shopDomain);
    merchantCache.set(key, merchant);
    return merchant;
  }

  router.post('/telemetry', async (req, res, next) => {
    try {
      // --- authentication (timing-safe) --------------------------------
      const authHeader = req.get('authorization') ?? '';
      const match = /^Bearer\s+(.+)$/i.exec(authHeader);
      const presented = match ? match[1].trim() : null;
      if (!timingSafeTokenCheck(presented, config.ingestApiToken)) {
        // Deliberately uniform 401 body for missing vs wrong token: no
        // oracle for probing which failure mode occurred.
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      // --- request shape ------------------------------------------------
      const body = req.body;
      if (body === null || typeof body !== 'object' || !Array.isArray(body.records)) {
        res.status(400).json({ error: 'body must be a JSON object with a records[] array' });
        return;
      }
      if (body.records.length > MAX_RECORDS_PER_BATCH) {
        res.status(413).json({
          error: 'batch too large',
          max_records: MAX_RECORDS_PER_BATCH,
          received: body.records.length,
        });
        return;
      }

      // --- per-record validation + merchant resolution ------------------
      let rejectedInvalid = 0;
      let skippedUnknownMerchant = 0;
      const insertRows = [];

      for (const record of body.records) {
        const verdict = validateTelemetryRecord(record);
        if (!verdict.ok) {
          rejectedInvalid += 1;
          // debug (not warn): partial records are an EXPECTED product of the
          // edge's never-throw telemetry builder, not an incident.
          logger.debug('telemetry record rejected', { reason: verdict.error });
          continue;
        }

        let merchant;
        try {
          merchant = await resolveMerchant(verdict.value.shopDomain);
        } catch (err) {
          // Merchant lookup is a DB call: if PostgreSQL is down we cannot
          // meaningfully ingest ANY of this batch — surface a 5xx so the
          // queue consumer retries the whole batch later (its retry/DLQ
          // machinery exists for exactly this; merchant traffic at the edge
          // is unaffected either way).
          throw err;
        }
        if (merchant === null) {
          skippedUnknownMerchant += 1;
          continue;
        }

        insertRows.push({
          merchantId: merchant.id,
          token: verdict.value.token,
          protocol: verdict.value.protocol,
          method: verdict.value.method,
          path: verdict.value.path,
          targetSku: verdict.value.targetSku,
          payload: verdict.value.payload,
        });
      }

      // --- single batch INSERT ------------------------------------------
      const inserted = insertRows.length > 0 ? await insertIntentLogsBatch(db, insertRows) : 0;

      if (rejectedInvalid > 0 || skippedUnknownMerchant > 0) {
        logger.info('telemetry batch ingested with drops', {
          inserted,
          skipped_unknown_merchant: skippedUnknownMerchant,
          rejected_invalid: rejectedInvalid,
        });
      }

      res.status(200).json({
        inserted,
        skipped_unknown_merchant: skippedUnknownMerchant,
        rejected_invalid: rejectedInvalid,
      });
    } catch (err) {
      // Central error handler logs + returns an opaque 500; the queue
      // consumer treats any 5xx as "retry this batch".
      next(err);
    }
  });

  return router;
}
