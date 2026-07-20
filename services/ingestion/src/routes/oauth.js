/**
 * routes/oauth.js — merchant onboarding: the Shopify OAuth install flow.
 *
 * Role in the AOP data flow:
 *   GET /auth/install?shop=x.myshopify.com
 *     -> validate shop -> redirect to Shopify's authorize page (signed state)
 *   GET /auth/callback?code&hmac&shop&state&timestamp   (from Shopify)
 *     -> verify Shopify's HMAC over the query + our state nonce
 *     -> exchange the code for an Admin API access token
 *     -> AES-256-GCM-encrypt the token (lib/token-crypto.js)
 *     -> UPSERT merchant_profiles (the row every telemetry record and
 *        webhook resolves against)
 *     -> register the orders/create webhook pointing at THIS service
 *     -> done: the store's agent traffic is attributable from this moment.
 *
 * Feature gate: requires SHOPIFY_API_KEY + SHOPIFY_API_SECRET +
 * TOKEN_ENCRYPTION_KEY + APP_URL. Unset -> uniform 503 (same pattern as the
 * analytics router): deployments that only run the pipeline need no OAuth
 * surface, and a half-configured install flow must fail closed.
 *
 * Failure philosophy: the callback is a browser-facing page. Auth failures
 * (bad HMAC/state/shop) get terse 4xx JSON — no oracle detail. Downstream
 * faults AFTER Shopify authenticated the request (token exchange down, DB
 * down) are 502/500 with a retry hint: the merchant can simply click install
 * again; the upsert makes retries idempotent.
 */

import express from 'express';
import {
  normalizeShopDomain,
  verifyOAuthHmac,
  createStateNonce,
  verifyStateNonce,
  buildAuthorizeUrl,
  deriveProxyHostname,
} from '../lib/shopify-oauth.js';
import { encryptToken } from '../lib/token-crypto.js';
import { upsertMerchantToken } from '../repositories.js';

/** Admin API version used for webhook registration. */
const ADMIN_API_VERSION = '2025-01';

/** Bound outbound Admin API calls; an unresponsive shop must not pin the flow. */
const ADMIN_TIMEOUT_MS = 10_000;

/**
 * Exchange the OAuth code for an access token.
 * @returns {Promise<string>} the access token.
 * @throws {Error} on any non-2xx / malformed response.
 */
async function exchangeCodeForToken({ shop, code, apiKey, apiSecret, adminBaseOverride }) {
  const base = adminBaseOverride ?? `https://${shop}`;
  const response = await fetch(`${base}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
    signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`token exchange failed: HTTP ${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  const token = payload?.access_token;
  if (typeof token !== 'string' || token === '') {
    throw new Error('token exchange returned no access_token');
  }
  return token;
}

/**
 * The webhook topics AOP needs and the route each delivers to. orders/create
 * bills the commission; refunds/create and orders/cancelled credit it back
 * (routes/webhooks.js) — registering only the first would make billing
 * charge-only, which is a merchant dispute waiting to happen.
 */
const WEBHOOK_TOPICS = [
  { topic: 'orders/create', route: '/webhooks/shopify/orders-create' },
  { topic: 'refunds/create', route: '/webhooks/shopify/refunds-create' },
  { topic: 'orders/cancelled', route: '/webhooks/shopify/orders-cancelled' },
];

/**
 * Register every AOP webhook topic against the merchant's Admin API.
 * Non-fatal by design: 422 "address already taken" means a reinstall (the
 * webhook exists) — fine; other failures are logged loudly but do not fail
 * the install (the merchant row exists; webhook registration can be retried
 * by reinstalling, and losing one surfaces as zero reconciliation/credits).
 * @returns {Promise<Record<string, 'registered'|'already_registered'|'failed'>>}
 *   per-topic outcome map, logged and echoed to the install response.
 */
async function registerWebhooks({ shop, accessToken, appUrl, logger, adminBaseOverride }) {
  const base = adminBaseOverride ?? `https://${shop}`;
  const results = {};
  for (const { topic, route } of WEBHOOK_TOPICS) {
    try {
      const response = await fetch(`${base}/admin/api/${ADMIN_API_VERSION}/webhooks.json`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-shopify-access-token': accessToken,
        },
        body: JSON.stringify({
          webhook: {
            topic,
            address: `${appUrl.replace(/\/+$/, '')}${route}`,
            format: 'json',
          },
        }),
        signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
      });
      if (response.status === 422) {
        results[topic] = 'already_registered'; // reinstall path
      } else if (!response.ok) {
        logger.error('webhook registration failed', { shop, topic, status: response.status });
        results[topic] = 'failed';
      } else {
        results[topic] = 'registered';
      }
    } catch (err) {
      logger.error('webhook registration errored', { shop, topic, err });
      results[topic] = 'failed';
    }
  }
  return results;
}

/**
 * Build the OAuth router.
 *
 * @param {{config: object, db: object, logger: object,
 *   adminBaseOverride?: string}} deps  adminBaseOverride points Admin API
 *   calls at a mock Shopify in tests/demos; undefined in production.
 * @returns {express.Router}
 */
export function buildOAuthRouter({ config, db, logger, adminBaseOverride }) {
  const router = express.Router();

  // ---- feature gate -------------------------------------------------------
  router.use((req, res, next) => {
    if (config.shopifyOauth === null) {
      res.status(503).json({
        error: 'merchant onboarding disabled (SHOPIFY_API_KEY/SHOPIFY_API_SECRET/TOKEN_ENCRYPTION_KEY/APP_URL not configured)',
      });
      return;
    }
    next();
  });

  // ---- GET /auth/install --------------------------------------------------
  router.get('/install', (req, res) => {
    const shop = normalizeShopDomain(req.query.shop);
    if (shop === null) {
      res.status(400).json({ error: 'shop must be a *.myshopify.com domain' });
      return;
    }
    const { apiKey, apiSecret } = config.shopifyOauth;
    const state = createStateNonce(apiSecret);
    res.redirect(
      302,
      buildAuthorizeUrl({ shop, apiKey, appUrl: config.shopifyOauth.appUrl, state }),
    );
  });

  // ---- GET /auth/callback -------------------------------------------------
  router.get('/callback', async (req, res, next) => {
    try {
      const { apiKey, apiSecret, appUrl, encryptionKey } = config.shopifyOauth;

      // Authenticity gates first; uniform 401, no detail oracle.
      const shop = normalizeShopDomain(req.query.shop);
      if (
        shop === null ||
        !verifyOAuthHmac(req.query, apiSecret) ||
        !verifyStateNonce(req.query.state, apiSecret)
      ) {
        logger.warn('oauth callback rejected', { shop: String(req.query.shop ?? '') });
        res.status(401).json({ error: 'invalid oauth callback' });
        return;
      }
      const code = typeof req.query.code === 'string' ? req.query.code : null;
      if (code === null || code === '') {
        res.status(400).json({ error: 'missing authorization code' });
        return;
      }

      // Shopify authenticated the request — downstream faults are retryable.
      let accessToken;
      try {
        accessToken = await exchangeCodeForToken({ shop, code, apiKey, apiSecret, adminBaseOverride });
      } catch (err) {
        logger.error('oauth token exchange failed', { shop, err });
        res.status(502).json({ error: 'token exchange failed — retry the install' });
        return;
      }

      // Encrypt-then-store: the plaintext token exists only in this scope.
      // Routing defaults land in the same upsert: origin = the shop's own
      // domain, proxy hostname derived from PROXY_HOSTNAME_SUFFIX (nullable).
      // The edge resolves these via GET /routes/resolve — installing IS
      // becoming routable; no worker redeploy.
      const ciphertext = encryptToken(accessToken, encryptionKey, shop);
      const merchant = await upsertMerchantToken(db, {
        shopDomain: shop,
        encryptedToken: ciphertext,
        proxyHostname: deriveProxyHostname(shop, config.proxyHostnameSuffix),
        originUrl: `https://${shop}`,
      });

      const webhookStatus = await registerWebhooks({
        shop,
        accessToken,
        appUrl,
        logger,
        adminBaseOverride,
      });

      logger.info('merchant installed', {
        shop,
        merchant_id: merchant.id,
        webhooks: webhookStatus,
      });
      res.status(200).json({
        ok: true,
        shop,
        merchant_id: merchant.id,
        webhooks: webhookStatus,
        proxy_hostname: merchant.proxy_hostname ?? null,
        next_step: merchant.proxy_hostname
          ? `Point your ACP/AP2 endpoint configuration at https://${merchant.proxy_hostname} — agent telemetry starts flowing immediately.`
          : 'Ask your AOP operator to assign your proxy hostname (merchant_profiles.proxy_hostname), then point your ACP/AP2 endpoints at it.',
      });
    } catch (err) {
      next(err); // central handler: opaque 500, full log
    }
  });

  return router;
}
