/**
 * routes/analytics.js — read-only API backing the Loss Diagnosis dashboard.
 *
 * Role in the AOP data flow:
 *   [PostgreSQL: intent logs / reconciled orders / loss diagnostics]
 *     --(repositories analytics reads)--> THIS ROUTER
 *     --JSON--> [dashboard SPA: stat cards, drop-off analysis, loss tables]
 *
 * Endpoints (bearer-gated; platform token OR merchant API key):
 *   GET /analytics/summary?days=7       stat-card numbers + conversion rate
 *   GET /analytics/loss-reasons?days=7  ranked loss reasons with revenue + share
 *   GET /analytics/activity?limit=50    interleaved WON/LOST live stream
 *   GET /analytics/traffic?days=7       protocol share, prompt categories, top SKUs
 *   GET /analytics/billing?month=YYYY-MM monthly commission statement per merchant
 *   GET /analytics/benchmark?days=7     price-competitiveness benchmark (Benchmark Engine)
 *   GET /analytics/lift?days=56         proof-of-lift: weekly conversion + split-half deltas
 *   GET /analytics/whoami               credential scope introspection
 * Key management (platform token ONLY):
 *   POST   /analytics/keys              mint a merchant key (plaintext shown once)
 *   GET    /analytics/keys[?merchant_id=] list keys (prefixes only, never hashes)
 *   DELETE /analytics/keys/:id          revoke (idempotent tombstone)
 * Edge enrichment management (platform token ONLY, migration 0015):
 *   PUT /analytics/enrichment           store optimizer-verified JSON-LD + gate
 *   GET /analytics/enrichment?merchant_id= current payload + gate
 *
 * Security model (multi-tenant since migration 0014):
 *   - Read-only aggregates; no per-consumer PII exists downstream anyway
 *     (redacted at the edge before storage).
 *   - TWO credential classes on one bearer header:
 *       platform — DASHBOARD_API_TOKEN, compared timing-safely; sees every
 *                  merchant and manages keys. SEPARATE from the edge
 *                  pipeline's write token by design.
 *       merchant — an 'aop_live_…' API key (lib/api-keys.js); resolved by
 *                  SHA-256 digest against merchant_api_keys and scoped to
 *                  exactly that merchant_id in every repository query.
 *     The platform check runs FIRST and the key path is shape-gated, so a
 *     platform token never costs a DB round trip.
 *   - UNIFORM 401 for every credential failure — missing header, malformed
 *     bearer, unknown key, revoked key — so a probe learns nothing about
 *     which stage rejected it.
 *   - Key management (/analytics/keys) is PLATFORM-ONLY: merchants use keys,
 *     they never mint them. A valid merchant key on an admin route is an
 *     authenticated-but-unauthorized 403 (no oracle: the route's existence
 *     is public in this open-source codebase anyway).
 *   - When DASHBOARD_API_TOKEN is unset the feature is OFF: uniform 503 on
 *     every route — an explicit "not configured" signal, never a bypass
 *     (merchant keys are unusable too: key auth requires the feature on).
 *   - CORS is enabled for config.dashboardAllowedOrigin (the SPA runs on a
 *     different origin in dev). Token-gated + cookie-less, so reflecting a
 *     wildcard origin leaks nothing that the token doesn't already gate.
 */

import express from 'express';
import { timingSafeTokenCheck } from '../lib/auth.js';
import { isApiKeyShaped, hashApiKey, generateApiKey } from '../lib/api-keys.js';
import { parseWindowDays, parseLimit, percentShare, parseBillingMonth } from '../lib/analytics-params.js';
import {
  getAnalyticsSummary,
  getLossReasonBreakdown,
  getLossPhaseBreakdown,
  getRecentActivity,
  getTrafficBreakdown,
  getBillingStatement,
  getPriceBenchmark,
  getLiftReport,
  findMerchantByShopDomain,
  findMerchantByApiKeyHash,
  insertMerchantApiKey,
  listMerchantApiKeys,
  revokeMerchantApiKey,
  getEnrichment,
  upsertEnrichment,
} from '../repositories.js';

/** Postgres UUID literal gate: bad ids become clean 4xx, never a 22P02 500. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the analytics router.
 *
 * @param {{config: object, db: object, logger: object}} deps
 * @returns {express.Router}
 */
export function buildAnalyticsRouter({ config, db, logger }) {
  const router = express.Router();

  // ---- CORS (this router only; the write surface stays same-origin) ------
  router.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', config.dashboardAllowedOrigin);
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // ---- feature gate + auth (uniform responses, no oracles) ---------------
  // Resolves req.aopAuth = {role: 'platform'|'merchant', merchantId,
  // shopDomain}. Every data route below scopes its repository call with
  // req.aopAuth.merchantId (null = platform-wide).
  router.use(async (req, res, next) => {
    if (config.dashboardApiToken === null) {
      res.status(503).json({ error: 'analytics disabled (DASHBOARD_API_TOKEN not configured)' });
      return;
    }
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
    const presented = match ? match[1].trim() : null;

    // 1. Platform token (timing-safe: a human-chosen secret).
    if (timingSafeTokenCheck(presented, config.dashboardApiToken)) {
      req.aopAuth = { role: 'platform', merchantId: null, shopDomain: null };
      next();
      return;
    }

    // 2. Merchant API key: shape gate first (no DB probe for arbitrary
    // bearers), then digest lookup (see lib/api-keys.js for why the hash
    // lookup needs no constant-time comparison).
    if (isApiKeyShaped(presented)) {
      let merchant;
      try {
        merchant = await findMerchantByApiKeyHash(db, hashApiKey(presented));
      } catch (err) {
        // DB failure is a server fault, not a credential verdict — the
        // central handler answers an opaque 500; never a false 401.
        next(err);
        return;
      }
      if (merchant) {
        req.aopAuth = { role: 'merchant', merchantId: merchant.merchant_id, shopDomain: merchant.shop_domain };
        next();
        return;
      }
    }

    // 3. UNIFORM rejection: missing, malformed, unknown, and revoked all
    // land here with an identical response.
    res.status(401).json({ error: 'unauthorized' });
  });

  /** Admin gate for key management: merchants never manage keys. */
  function platformOnly(req, res) {
    if (req.aopAuth.role !== 'platform') {
      res.status(403).json({ error: 'forbidden' });
      return false;
    }
    return true;
  }

  // ---- GET /analytics/whoami ---------------------------------------------
  // Lets the dashboard label its scope ("All merchants" vs the shop) and
  // gives operators a cheap credential smoke test.
  router.get('/whoami', (req, res) => {
    res.json({
      role: req.aopAuth.role,
      merchant_id: req.aopAuth.merchantId,
      shop_domain: req.aopAuth.shopDomain,
    });
  });

  // ---- GET /analytics/summary --------------------------------------------
  router.get('/summary', async (req, res, next) => {
    try {
      const windowDays = parseWindowDays(req.query.days);
      const merchantId = req.aopAuth.merchantId;
      const [summary, phases] = await Promise.all([
        getAnalyticsSummary(db, { windowDays, merchantId }),
        getLossPhaseBreakdown(db, { windowDays, merchantId }),
      ]);

      // Agent Conversion Rate: reconciled orders per intent impression —
      // the metric headless merchants cannot compute anywhere else.
      const conversionRatePct = percentShare(summary.orders_won, summary.impressions);

      // "Critical drop-off": the phase where most losses died, with share.
      const totalPhaseLosses = phases.reduce((sum, p) => sum + p.count, 0);
      const topPhase = phases[0] ?? null;

      res.json({
        window_days: windowDays,
        impressions: summary.impressions,
        orders_won: summary.orders_won,
        // MONEY is per-currency only (mirrors the billing contract): each
        // entry carries gross, credits, and SQL-subtracted net figures.
        // There are deliberately NO cross-currency scalar money totals.
        currencies: summary.currencies,
        adjustments: summary.adjustments,
        conversion_rate_pct: conversionRatePct,
        losses: summary.losses,
        // Heuristic cents from agent payloads — no currency evidence; render
        // unlabeled, never with a currency symbol.
        estimated_losses: summary.estimated_losses,
        critical_dropoff: topPhase
          ? {
              phase: topPhase.phase,
              share_pct: percentShare(topPhase.count, totalPhaseLosses),
              count: topPhase.count,
            }
          : null,
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- GET /analytics/loss-reasons ---------------------------------------
  router.get('/loss-reasons', async (req, res, next) => {
    try {
      const windowDays = parseWindowDays(req.query.days);
      const reasons = await getLossReasonBreakdown(db, { windowDays, merchantId: req.aopAuth.merchantId });
      const totalCount = reasons.reduce((sum, r) => sum + r.count, 0);
      res.json({
        window_days: windowDays,
        total: totalCount,
        reasons: reasons.map((r) => ({
          ...r,
          share_pct: percentShare(r.count, totalCount),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- GET /analytics/traffic ----------------------------------------------
  router.get('/traffic', async (req, res, next) => {
    try {
      const windowDays = parseWindowDays(req.query.days);
      const breakdown = await getTrafficBreakdown(db, { windowDays, merchantId: req.aopAuth.merchantId });
      const protocolTotal = breakdown.protocols.reduce((sum, p) => sum + p.count, 0);
      const intentTotal = breakdown.intent_categories.reduce((sum, c) => sum + c.count, 0);
      res.json({
        window_days: windowDays,
        protocols: breakdown.protocols.map((p) => ({ ...p, share_pct: percentShare(p.count, protocolTotal) })),
        intent_categories: breakdown.intent_categories.map((c) => ({
          ...c,
          share_pct: percentShare(c.count, intentTotal),
        })),
        top_skus: breakdown.top_skus,
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- GET /analytics/billing ----------------------------------------------
  router.get('/billing', async (req, res, next) => {
    try {
      const { label, startDate } = parseBillingMonth(req.query.month);
      const lines = await getBillingStatement(db, {
        monthStartDate: startDate,
        merchantId: req.aopAuth.merchantId,
      });
      // Totals in integer cents — never float-sum decimal strings — and PER
      // CURRENCY: statement lines are (merchant, currency) grains and EUR
      // never sums into USD (migration 0010).
      const cents = (v) => Math.round(Number(v) * 100);
      const byCurrency = new Map();
      for (const line of lines) {
        const acc = byCurrency.get(line.currency) ?? {
          currency: line.currency,
          orders: 0,
          gmv_cents: 0,
          commission_cents: 0,
          adjustments: 0,
          adjusted_gmv_cents: 0,
          commission_credit_cents: 0,
        };
        acc.orders += line.orders;
        acc.gmv_cents += cents(line.gmv);
        acc.commission_cents += cents(line.commission);
        acc.adjustments += line.adjustments;
        acc.adjusted_gmv_cents += cents(line.adjusted_gmv);
        acc.commission_credit_cents += cents(line.commission_credits);
        byCurrency.set(line.currency, acc);
      }
      // Sign-safe cents -> decimal (net figures can go negative in a month
      // that credits more than it charges).
      const decimal = (c) => {
        const sign = c < 0 ? '-' : '';
        const abs = Math.abs(c);
        return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
      };
      res.json({
        month: label,
        lines,
        totals: [...byCurrency.values()].map((t) => ({
          currency: t.currency,
          orders: t.orders,
          gmv: decimal(t.gmv_cents),
          commission: decimal(t.commission_cents),
          adjustments: t.adjustments,
          adjusted_gmv: decimal(t.adjusted_gmv_cents),
          commission_credits: decimal(t.commission_credit_cents),
          net_gmv: decimal(t.gmv_cents - t.adjusted_gmv_cents),
          net_commission: decimal(t.commission_cents - t.commission_credit_cents),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- GET /analytics/benchmark --------------------------------------------
  router.get('/benchmark', async (req, res, next) => {
    try {
      const windowDays = parseWindowDays(req.query.days);
      const benchmark = await getPriceBenchmark(db, { windowDays, merchantId: req.aopAuth.merchantId });
      // Cents -> decimal strings at the edge of the API (money never floats).
      const money = (c) => (c === null ? null : `${Math.floor(c / 100)}.${String(Math.round(c) % 100).padStart(2, '0')}`);
      res.json({
        window_days: windowDays,
        price_losses: benchmark.price_losses,
        revenue_lost: benchmark.revenue_lost,
        avg_undercut: money(benchmark.avg_delta_cents),
        avg_our_price: money(benchmark.avg_our_price_cents),
        avg_competitor_price: money(benchmark.avg_competitor_price_cents),
        by_sku: benchmark.by_sku.map((row) => ({
          sku: row.sku,
          losses: row.losses,
          avg_undercut: money(row.avg_delta_cents),
          avg_our_price: money(row.avg_our_price_cents),
          avg_competitor_price: money(row.avg_competitor_price_cents),
          revenue_lost: row.revenue_lost,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- GET /analytics/lift -------------------------------------------------
  // Proof-of-lift: weekly conversion series + exact equal-length split
  // comparison (recent halfDays vs the same-length period before it) +
  // loss-reason shifts. OBSERVED counts only — conversion_lift_pct is null
  // (not 0, not invented) whenever either half has no impressions or the
  // baseline has no conversions to compare against. Default window 56 days
  // (8 weekly buckets); ?days overrides within the standard [1, 90] bounds.
  router.get('/lift', async (req, res, next) => {
    try {
      const windowDays = parseWindowDays(req.query.days ?? '56');
      const halfDays = Math.max(1, Math.floor(windowDays / 2));
      const raw = await getLiftReport(db, { windowDays, halfDays, merchantId: req.aopAuth.merchantId });

      // Merge the three sparse weekly series on the week key.
      const weeks = new Map();
      const weekEntry = (weekValue) => {
        const key = new Date(weekValue).toISOString();
        if (!weeks.has(key)) {
          weeks.set(key, {
            week_start: key,
            impressions: 0,
            orders_won: 0,
            losses: 0,
            estimated_revenue_lost: '0',
          });
        }
        return weeks.get(key);
      };
      for (const row of raw.weeklyIntents) weekEntry(row.week).impressions = Number(row.impressions);
      for (const row of raw.weeklyWins) weekEntry(row.week).orders_won = Number(row.orders_won);
      for (const row of raw.weeklyLosses) {
        const entry = weekEntry(row.week);
        entry.losses = Number(row.losses);
        entry.estimated_revenue_lost = String(row.estimated_revenue_lost);
      }
      const weekly = [...weeks.values()]
        .sort((a, b) => a.week_start.localeCompare(b.week_start))
        .map((w) => ({ ...w, conversion_rate_pct: percentShare(w.orders_won, w.impressions) }));

      const half = (impressions, orders) => ({
        impressions: Number(impressions),
        orders_won: Number(orders),
        // Display rate only (one-decimal rounding) — the lift ratio below
        // deliberately does NOT use it.
        conversion_rate_pct: percentShare(orders, impressions),
      });
      const baseline = half(raw.split.imp_baseline, raw.split.won_baseline);
      const recent = half(raw.split.imp_recent, raw.split.won_recent);

      // Relative lift in conversion rate, computed from RAW COUNTS — the
      // display rates are rounded to one decimal and dividing rounded
      // values would fabricate or erase lift at low conversion rates (a
      // 0.078% -> 0.122% move both display as 0.1%). Null when unknowable:
      // no impressions in either half, or zero baseline conversions
      // (relative change from zero is undefined — the absolute rates are
      // right there for that case).
      const conversionLiftPct =
        baseline.impressions > 0 && recent.impressions > 0 && baseline.orders_won > 0
          ? Math.round(
              ((recent.orders_won / recent.impressions) / (baseline.orders_won / baseline.impressions) - 1) * 1000
            ) / 10
          : null;

      res.json({
        window_days: windowDays,
        recent_days: halfDays,
        // Equal-length halves (see getLiftReport): raw-count reason deltas
        // stay duration-fair for odd windows.
        baseline_days: halfDays,
        baseline,
        recent,
        conversion_lift_pct: conversionLiftPct,
        weekly,
        // Negative delta = fewer losses of that reason in the recent half.
        reason_shifts: raw.reasons
          .map((r) => ({
            reason: r.reason,
            baseline_count: Number(r.baseline_count),
            recent_count: Number(r.recent_count),
            delta: Number(r.recent_count) - Number(r.baseline_count),
          }))
          .sort((a, b) => a.delta - b.delta),
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- GET /analytics/activity -------------------------------------------
  router.get('/activity', async (req, res, next) => {
    try {
      const limit = parseLimit(req.query.limit);
      const events = await getRecentActivity(db, { limit, merchantId: req.aopAuth.merchantId });
      res.json({ limit, events });
    } catch (err) {
      next(err);
    }
  });

  // ---- Key management (platform only) ------------------------------------

  // POST /analytics/keys {merchant_id | shop_domain, label?} -> mint a key.
  // The plaintext appears in THIS response and nowhere else — not in logs,
  // not in the database (lib/api-keys.js stores digest + display prefix).
  router.post('/keys', async (req, res, next) => {
    if (!platformOnly(req, res)) return;
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};

      // Resolve the target merchant from exactly one of the two selectors.
      let merchantId = null;
      if (typeof body.merchant_id === 'string' && UUID_SHAPE.test(body.merchant_id.trim())) {
        merchantId = body.merchant_id.trim().toLowerCase();
      } else if (typeof body.shop_domain === 'string' && body.shop_domain.trim() !== '') {
        const merchant = await findMerchantByShopDomain(db, body.shop_domain.trim());
        merchantId = merchant?.id ?? null;
      } else {
        res.status(400).json({ error: 'merchant_id (uuid) or shop_domain is required' });
        return;
      }
      if (merchantId === null) {
        res.status(404).json({ error: 'merchant not found' });
        return;
      }

      const label =
        typeof body.label === 'string' && body.label.trim() !== '' ? body.label.trim().slice(0, 120) : null;

      const minted = generateApiKey();
      let stored;
      try {
        stored = await insertMerchantApiKey(db, {
          merchantId,
          keyHash: minted.keyHash,
          keyPrefix: minted.keyPrefix,
          label,
        });
      } catch (err) {
        // FK violation: merchant_id shaped fine but doesn't exist (or was
        // deleted mid-flight). A clean 404 beats an opaque 500.
        if (err?.code === '23503') {
          res.status(404).json({ error: 'merchant not found' });
          return;
        }
        throw err;
      }

      logger.info('merchant api key minted', {
        key_id: stored.id,
        merchant_id: merchantId,
        key_prefix: stored.key_prefix, // display prefix only — NEVER the key
      });
      res.status(201).json({
        id: stored.id,
        merchant_id: merchantId,
        key_prefix: stored.key_prefix,
        label,
        created_at: stored.created_at,
        // Shown exactly once; the caller must store it now.
        api_key: minted.plaintext,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /analytics/keys[?merchant_id=uuid] -> inventory (no hashes).
  router.get('/keys', async (req, res, next) => {
    if (!platformOnly(req, res)) return;
    try {
      let merchantId = null;
      if (req.query.merchant_id !== undefined) {
        const raw = String(req.query.merchant_id).trim();
        if (!UUID_SHAPE.test(raw)) {
          res.status(400).json({ error: 'merchant_id must be a uuid' });
          return;
        }
        merchantId = raw.toLowerCase();
      }
      const keys = await listMerchantApiKeys(db, { merchantId });
      res.json({ keys });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /analytics/keys/:id -> revoke. Idempotent: revoking twice is 200.
  router.delete('/keys/:id', async (req, res, next) => {
    if (!platformOnly(req, res)) return;
    try {
      const keyId = String(req.params.id ?? '').trim();
      if (!UUID_SHAPE.test(keyId)) {
        res.status(404).json({ error: 'key not found' });
        return;
      }
      const outcome = await revokeMerchantApiKey(db, keyId.toLowerCase());
      if (outcome === 'not_found') {
        res.status(404).json({ error: 'key not found' });
        return;
      }
      res.json({ id: keyId.toLowerCase(), status: outcome });
    } catch (err) {
      next(err);
    }
  });

  // ---- Edge enrichment management (platform only, migration 0015) --------
  // The stored payload is what the EDGE INJECTS VERBATIM into merchant HTML,
  // so the write path is the fabrication gate: only schema.org-shaped
  // JSON-LD (produced by the optimizer from merchant-supplied facts) within
  // a hard size cap is accepted. Nothing here or at the edge generates
  // content.

  /** Serialized payload cap: cached per-hostname on every edge isolate. */
  const ENRICHMENT_MAX_BYTES = 32 * 1024;

  /** True for a plausible schema.org JSON-LD block (object form). */
  function isJsonLdBlock(value) {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof value['@context'] === 'string' &&
      /schema\.org/i.test(value['@context']) &&
      typeof value['@type'] === 'string' &&
      value['@type'].trim() !== ''
    );
  }

  // PUT /analytics/enrichment {merchant_id|shop_domain, jsonld, enabled}
  router.put('/enrichment', async (req, res, next) => {
    if (!platformOnly(req, res)) return;
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};

      let merchantId = null;
      if (typeof body.merchant_id === 'string' && UUID_SHAPE.test(body.merchant_id.trim())) {
        merchantId = body.merchant_id.trim().toLowerCase();
      } else if (typeof body.shop_domain === 'string' && body.shop_domain.trim() !== '') {
        const merchant = await findMerchantByShopDomain(db, body.shop_domain.trim());
        merchantId = merchant?.id ?? null;
      } else {
        res.status(400).json({ error: 'merchant_id (uuid) or shop_domain is required' });
        return;
      }
      if (merchantId === null) {
        res.status(404).json({ error: 'merchant not found' });
        return;
      }

      if (typeof body.enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled (boolean) is required' });
        return;
      }

      // jsonld: null clears; otherwise one JSON-LD object or a non-empty
      // array of them, every block schema.org-shaped, bounded size.
      let jsonld = null;
      if (body.jsonld !== null && body.jsonld !== undefined) {
        const blocks = Array.isArray(body.jsonld) ? body.jsonld : [body.jsonld];
        if (blocks.length === 0 || !blocks.every(isJsonLdBlock)) {
          res.status(400).json({
            error: 'jsonld must be a schema.org JSON-LD object (or non-empty array of them) with @context and @type',
          });
          return;
        }
        let serialized;
        try {
          serialized = JSON.stringify(body.jsonld);
        } catch {
          res.status(400).json({ error: 'jsonld must be JSON-serializable' });
          return;
        }
        if (Buffer.byteLength(serialized, 'utf8') > ENRICHMENT_MAX_BYTES) {
          res.status(400).json({ error: `jsonld exceeds ${ENRICHMENT_MAX_BYTES} bytes` });
          return;
        }
        // NUL smuggling guard (PostgreSQL jsonb rejects U+0000 anyway; catch
        // it here with an honest 400 instead of a 500).
        if (serialized.includes('\\u0000')) {
          res.status(400).json({ error: 'jsonld must not contain U+0000' });
          return;
        }
        jsonld = body.jsonld;
      }

      if (body.enabled === true && jsonld === null) {
        // Mirrors the DB CHECK: the gate cannot be on with nothing to inject.
        res.status(400).json({ error: 'enabled=true requires a jsonld payload' });
        return;
      }

      const { updated } = await upsertEnrichment(db, { merchantId, jsonld, enabled: body.enabled });
      if (!updated) {
        res.status(404).json({ error: 'merchant not found' });
        return;
      }
      logger.info('merchant enrichment updated', {
        merchant_id: merchantId,
        enabled: body.enabled,
        has_payload: jsonld !== null,
      });
      res.json(await getEnrichment(db, merchantId));
    } catch (err) {
      next(err);
    }
  });

  // GET /analytics/enrichment?merchant_id=uuid
  router.get('/enrichment', async (req, res, next) => {
    if (!platformOnly(req, res)) return;
    try {
      const raw = String(req.query.merchant_id ?? '').trim();
      if (!UUID_SHAPE.test(raw)) {
        res.status(400).json({ error: 'merchant_id (uuid) is required' });
        return;
      }
      const enrichment = await getEnrichment(db, raw.toLowerCase());
      if (enrichment === null) {
        res.status(404).json({ error: 'merchant not found' });
        return;
      }
      res.json(enrichment);
    } catch (err) {
      next(err);
    }
  });

  // Log analytics failures with route context; the central handler answers.
  // Param-decode URIErrors (malformed percent-encoding in /keys/:id) are a
  // client typo the central handler maps to 400 — not a query failure, so
  // don't page error-level for them.
  router.use((err, req, res, next) => {
    if (!(err instanceof URIError)) {
      logger.error('analytics query failed', { err, path: req.path });
    }
    next(err);
  });

  return router;
}
