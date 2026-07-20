/**
 * routes/analytics.js — read-only API backing the Loss Diagnosis dashboard.
 *
 * Role in the AOP data flow:
 *   [PostgreSQL: intent logs / reconciled orders / loss diagnostics]
 *     --(repositories analytics reads)--> THIS ROUTER
 *     --JSON--> [dashboard SPA: stat cards, drop-off analysis, loss tables]
 *
 * Endpoints (all GET, all bearer-gated by DASHBOARD_API_TOKEN):
 *   /analytics/summary?days=7       stat-card numbers + conversion rate
 *   /analytics/loss-reasons?days=7  ranked loss reasons with revenue + share
 *   /analytics/activity?limit=50    interleaved WON/LOST live stream
 *   /analytics/traffic?days=7       protocol share, prompt categories, top SKUs
 *   /analytics/billing?month=YYYY-MM monthly commission statement per merchant
 *   /analytics/benchmark?days=7     price-competitiveness benchmark (Benchmark Engine)
 *
 * Security model:
 *   - Read-only aggregates; no per-consumer PII exists downstream anyway
 *     (redacted at the edge before storage).
 *   - Bearer auth with the same timing-safe comparison as the ingest route,
 *     but a SEPARATE credential: the dashboard must never hold the edge
 *     pipeline's write token.
 *   - When DASHBOARD_API_TOKEN is unset the feature is OFF: uniform 503 on
 *     every route — an explicit "not configured" signal, never a bypass.
 *   - CORS is enabled for config.dashboardAllowedOrigin (the SPA runs on a
 *     different origin in dev). Token-gated + cookie-less, so reflecting a
 *     wildcard origin leaks nothing that the token doesn't already gate.
 */

import express from 'express';
import { timingSafeTokenCheck } from '../lib/auth.js';
import { parseWindowDays, parseLimit, percentShare, parseBillingMonth } from '../lib/analytics-params.js';
import {
  getAnalyticsSummary,
  getLossReasonBreakdown,
  getLossPhaseBreakdown,
  getRecentActivity,
  getTrafficBreakdown,
  getBillingStatement,
  getPriceBenchmark,
} from '../repositories.js';

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
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // ---- feature gate + auth (uniform responses, no oracles) ---------------
  router.use((req, res, next) => {
    if (config.dashboardApiToken === null) {
      res.status(503).json({ error: 'analytics disabled (DASHBOARD_API_TOKEN not configured)' });
      return;
    }
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
    const presented = match ? match[1].trim() : null;
    if (!timingSafeTokenCheck(presented, config.dashboardApiToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  // ---- GET /analytics/summary --------------------------------------------
  router.get('/summary', async (req, res, next) => {
    try {
      const windowDays = parseWindowDays(req.query.days);
      const [summary, phases] = await Promise.all([
        getAnalyticsSummary(db, { windowDays }),
        getLossPhaseBreakdown(db, { windowDays }),
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
      const reasons = await getLossReasonBreakdown(db, { windowDays });
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
      const breakdown = await getTrafficBreakdown(db, { windowDays });
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
      const lines = await getBillingStatement(db, { monthStartDate: startDate });
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
      const benchmark = await getPriceBenchmark(db, { windowDays });
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

  // ---- GET /analytics/activity -------------------------------------------
  router.get('/activity', async (req, res, next) => {
    try {
      const limit = parseLimit(req.query.limit);
      const events = await getRecentActivity(db, { limit });
      res.json({ limit, events });
    } catch (err) {
      next(err);
    }
  });

  // Log analytics failures with route context; the central handler answers.
  router.use((err, req, res, next) => {
    logger.error('analytics query failed', { err, path: req.path });
    next(err);
  });

  return router;
}
