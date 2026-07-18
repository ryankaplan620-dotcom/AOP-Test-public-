/**
 * demo/mock-storefront.mjs — a fake headless Shopify storefront (demo only).
 *
 * Role in the AOP data flow (demo):
 *   [agent-simulator] --GET /availability, POST /shipping_quote--> THIS
 *   (optionally via the real edge worker in `wrangler dev`, which proxies to
 *   this origin exactly as it would to a live Shopify backend)
 *
 *   It also plays Shopify's other role: POST /admin/fire-order-webhook makes
 *   it deliver a correctly HMAC-SHA256-signed orders/create webhook to the
 *   ingestion service — the same bytes-signed contract real Shopify uses —
 *   so the demo exercises the true attribution path, not a shortcut.
 *
 * Endpoints:
 *   GET  /availability?sku=SKU     inventory answer from the demo catalog
 *   POST /shipping_quote           echoes a quote for the requested items
 *   POST /admin/fire-order-webhook {token, order_total, sku} -> signs + sends
 *   GET  /healthz
 *
 * Env: PORT (default 9100), INGEST_URL (default http://localhost:8787),
 *      SHOPIFY_WEBHOOK_SECRET (default dev-secret), SHOP_DOMAIN
 *      (default redthreadapparel.com — must match the seeded merchant row).
 *
 * Plain Node stdlib — the demo adds zero dependencies.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { CATALOG } from './lib/scenarios.js';

const PORT = Number(process.env.PORT ?? 9100);
const INGEST_URL = (process.env.INGEST_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET ?? 'dev-secret';
const SHOP_DOMAIN = process.env.SHOP_DOMAIN ?? 'redthreadapparel.com';

const bySku = new Map(CATALOG.map((p) => [p.sku, p]));
let orderSequence = 77000001; // fake Shopify order ids, monotonic

/** Read a bounded JSON body; resolves null on parse failure. */
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Sign and deliver an orders/create webhook to the ingestion service —
 * byte-exact HMAC over the serialized body, like real Shopify.
 */
async function fireOrderWebhook({ token, orderTotal, sku }) {
  const order = {
    id: orderSequence++,
    total_price: orderTotal,
    currency: 'USD',
    line_items: [{ sku, quantity: 1 }],
    note_attributes: [{ name: 'aop_transaction_token', value: token }],
  };
  const body = JSON.stringify(order);
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('base64');

  const response = await fetch(`${INGEST_URL}/webhooks/shopify/orders-create`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-shop-domain': SHOP_DOMAIN,
      'x-shopify-topic': 'orders/create',
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json().catch(() => null), order_id: order.id };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok', role: 'mock-storefront' });
      return;
    }

    // The storefront surface the edge proxy forwards agent probes to.
    if (req.method === 'GET' && url.pathname.endsWith('/availability')) {
      const sku = url.searchParams.get('sku');
      const product = bySku.get(sku);
      if (!product) {
        sendJson(res, 404, { sku, available: false, error: 'unknown sku' });
        return;
      }
      sendJson(res, 200, { sku, available: true, price: product.price, currency: 'USD' });
      return;
    }

    if (req.method === 'POST' && url.pathname.endsWith('/shipping_quote')) {
      const body = await readJson(req);
      const sku = body?.items?.[0]?.sku ?? null;
      sendJson(res, 200, {
        sku,
        quotes: [
          { service: 'standard', delivery_days: 4, price: 5.0 },
          { service: 'express', delivery_days: 2, price: 14.0 },
        ],
      });
      return;
    }

    // Shopify's role: deliver the signed order webhook on demand.
    if (req.method === 'POST' && url.pathname === '/admin/fire-order-webhook') {
      const body = await readJson(req);
      const token = typeof body?.token === 'string' ? body.token : null;
      const orderTotal = typeof body?.order_total === 'string' ? body.order_total : null;
      const sku = typeof body?.sku === 'string' ? body.sku : 'UNSPECIFIED';
      if (!token || !orderTotal) {
        sendJson(res, 400, { error: 'token and order_total (decimal string) are required' });
        return;
      }
      const result = await fireOrderWebhook({ token, orderTotal, sku });
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, () => {
  console.error(`[mock-storefront] ${SHOP_DOMAIN} on http://localhost:${PORT} -> webhooks to ${INGEST_URL}`);
});
