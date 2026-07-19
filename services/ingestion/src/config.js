/**
 * config.js — environment loading + validation for the AOP ingestion service.
 *
 * Role in the AOP data flow:
 *   [edge queue consumer] --HTTPS POST--> [THIS SERVICE] --> [PostgreSQL]
 *   [Shopify webhooks]    --HTTPS POST--> [THIS SERVICE] --> [PostgreSQL]
 *
 *   Every subsystem of the ingestion service (telemetry ingest auth, Shopify
 *   webhook HMAC verification, the PostgreSQL pool, and the loss-diagnostics
 *   sweep cadence) is parameterized here. Config is loaded ONCE at boot
 *   (src/index.js) and passed down explicitly — no module reads process.env
 *   at call time, which keeps every other module unit-testable and makes the
 *   full set of runtime knobs visible in one place.
 *
 * Fail-fast contract:
 *   A missing or malformed variable must stop the process at boot with a
 *   message listing EVERY problem at once (not just the first), so an operator
 *   fixes the deployment in one pass instead of playing whack-a-mole. This is
 *   deliberate and safe: this service is OFF the merchant's live traffic path
 *   (the Cloudflare Worker edge proxy keeps passing agent requests through to
 *   Shopify whether or not ingestion is up), so refusing to boot half-configured
 *   loses nothing and prevents silently unauthenticated ingest or unverified
 *   webhooks.
 */

/**
 * Typed error so src/index.js can distinguish "operator misconfigured the
 * deployment" (print message, exit 1, no stack spam) from an unexpected crash.
 */
import { parseEncryptionKey } from './lib/token-crypto.js';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Variables that have no sane default and MUST be provided. */
const REQUIRED_VARS = [
  // PostgreSQL connection string (postgres://...). The pool in src/db.js
  // consumes it verbatim, so any libpq-style URL options are honored.
  'DATABASE_URL',
  // Shared bearer token the edge queue consumer presents on
  // POST /ingest/telemetry. Compared timing-safely in src/lib/auth.js.
  'INGEST_API_TOKEN',
  // Shopify app webhook signing secret used to verify the
  // X-Shopify-Hmac-Sha256 header on order-created webhooks.
  'SHOPIFY_WEBHOOK_SECRET',
];

/**
 * Parse an optional positive-integer variable with a default.
 * Pushes a descriptive problem string instead of throwing so the caller can
 * aggregate every issue into a single fail-fast message.
 */
function parsePositiveInt(env, name, defaultValue, problems, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue;
  }
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(
      `${name}="${raw}" is invalid — expected an integer between ${min} and ${max} (default when unset: ${defaultValue})`
    );
    return defaultValue; // returned value is irrelevant; problems[] aborts boot
  }
  return value;
}

/**
 * Load and validate configuration from an env map (defaults to process.env —
 * injectable for tests).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   databaseUrl: string,
 *   ingestApiToken: string,
 *   shopifyWebhookSecret: string,
 *   port: number,
 *   intentExpirySeconds: number,
 *   lossSweepIntervalMs: number,
 * }}
 * @throws {ConfigError} listing every missing/invalid variable at once.
 */
export function loadConfig(env = process.env) {
  const problems = [];

  // --- required secrets/connection strings -------------------------------
  const missing = REQUIRED_VARS.filter((name) => {
    const value = env[name];
    return value === undefined || value === null || String(value).trim() === '';
  });
  if (missing.length > 0) {
    problems.push(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'All three are mandatory: DATABASE_URL (PostgreSQL connection string), ' +
        'INGEST_API_TOKEN (bearer token for POST /ingest/telemetry), ' +
        'SHOPIFY_WEBHOOK_SECRET (HMAC secret for Shopify webhooks).'
    );
  }

  // --- optional, defaulted knobs -----------------------------------------
  // PORT: standard TCP range. 8787 mirrors the wrangler dev default so local
  // edge-worker + ingestion setups line up without extra flags.
  const port = parsePositiveInt(env, 'PORT', 8787, problems, { min: 1, max: 65535 });

  // The conversion window: an intent older than this with no reconciled order
  // is considered a drop-off and becomes a loss_diagnostics row. Product
  // default is 60 seconds (agent checkouts are near-instant; a human-speed
  // window would just delay loss analytics).
  const intentExpirySeconds = parsePositiveInt(env, 'INTENT_EXPIRY_SECONDS', 60, problems, {
    min: 1,
    max: 86400, // > 1 day would silently disable loss analytics; treat as a typo
  });

  // Sweep cadence. Floor of 1000ms: a sub-second interval would let sweep
  // queries stack up against the same PostgreSQL pool the ingest hot path uses.
  const lossSweepIntervalMs = parsePositiveInt(env, 'LOSS_SWEEP_INTERVAL_MS', 15000, problems, {
    min: 1000,
    max: 3600000,
  });

  // Retention (compliance memo: 90-day cap). retentionDays bounds how long
  // intent telemetry lives; the in-process sweep enforces it every
  // retentionSweepIntervalMs (default 6h). Billing rows are never purged.
  const retentionDays = parsePositiveInt(env, 'RETENTION_DAYS', 90, problems, {
    min: 1,
    max: 3650,
  });
  const retentionSweepIntervalMs = parsePositiveInt(env, 'RETENTION_SWEEP_INTERVAL_MS', 21600000, problems, {
    min: 60000, // sub-minute purge polling is pointless load
    max: 86400000,
  });

  // --- dashboard analytics (optional feature) ----------------------------
  // DASHBOARD_API_TOKEN gates the read-only /analytics/* routes consumed by
  // the merchant Loss Diagnosis dashboard. OPTIONAL by design: deployments
  // that only run the write path (edge -> ingest -> DB) need no dashboard
  // credential, and the analytics router answers 503 until one is set —
  // an explicit "feature not configured" signal, never an auth bypass.
  const dashboardTokenRaw = env.DASHBOARD_API_TOKEN;
  const dashboardApiToken =
    dashboardTokenRaw !== undefined && dashboardTokenRaw !== null && String(dashboardTokenRaw).trim() !== ''
      ? String(dashboardTokenRaw).trim()
      : null;

  // CORS origin reflected on /analytics/* responses only (the dashboard SPA
  // runs on a different origin in dev). '*' is acceptable because the routes
  // are bearer-token-gated and carry no cookies; pin it in production.
  const dashboardAllowedOrigin =
    env.DASHBOARD_ALLOWED_ORIGIN !== undefined && String(env.DASHBOARD_ALLOWED_ORIGIN).trim() !== ''
      ? String(env.DASHBOARD_ALLOWED_ORIGIN).trim()
      : '*';

  // --- merchant onboarding (optional feature, all-or-nothing group) ------
  // The Shopify OAuth install flow needs all four; a partial configuration
  // fails the boot loudly rather than shipping a half-working install page.
  const oauthVars = ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'TOKEN_ENCRYPTION_KEY', 'APP_URL'];
  const oauthPresent = oauthVars.filter((name) => {
    const value = env[name];
    return value !== undefined && value !== null && String(value).trim() !== '';
  });
  let shopifyOauth = null;
  if (oauthPresent.length > 0 && oauthPresent.length < oauthVars.length) {
    problems.push(
      `Merchant onboarding is partially configured: have [${oauthPresent.join(', ')}], ` +
        `missing [${oauthVars.filter((v) => !oauthPresent.includes(v)).join(', ')}]. ` +
        'Set all four (or none, to disable the /auth routes).'
    );
  } else if (oauthPresent.length === oauthVars.length) {
    try {
      shopifyOauth = {
        apiKey: String(env.SHOPIFY_API_KEY).trim(),
        apiSecret: String(env.SHOPIFY_API_SECRET).trim(),
        appUrl: String(env.APP_URL).trim().replace(/\/+$/, ''),
        encryptionKey: parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY),
      };
    } catch (err) {
      problems.push(String(err?.message ?? err));
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(
      'AOP ingestion service refused to start — configuration problems:\n' +
        problems.map((p) => `  - ${p}`).join('\n')
    );
  }

  // Proxy-hostname suffix for OAuth-derived routing (e.g. '.agents.example
  // .com'): install derives proxy_hostname = <shop handle> + suffix. OPTIONAL:
  // unset leaves proxy_hostname NULL (operator assigns routing manually).
  let proxyHostnameSuffix = null;
  const suffixRaw = env.PROXY_HOSTNAME_SUFFIX;
  if (suffixRaw !== undefined && suffixRaw !== null && String(suffixRaw).trim() !== '') {
    const suffix = String(suffixRaw).trim().toLowerCase();
    if (/^\.[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(suffix)) {
      proxyHostnameSuffix = suffix;
    } else {
      problems.push(
        `PROXY_HOSTNAME_SUFFIX="${suffixRaw}" is invalid — expected a dot-prefixed domain suffix like ".agents.example.com"`
      );
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(
      'AOP ingestion service refused to start — configuration problems:\n' +
        problems.map((p) => `  - ${p}`).join('\n')
    );
  }

  return {
    databaseUrl: String(env.DATABASE_URL).trim(),
    ingestApiToken: String(env.INGEST_API_TOKEN).trim(),
    shopifyWebhookSecret: String(env.SHOPIFY_WEBHOOK_SECRET).trim(),
    port,
    intentExpirySeconds,
    lossSweepIntervalMs,
    retentionDays,
    retentionSweepIntervalMs,
    dashboardApiToken,
    dashboardAllowedOrigin,
    // null when the onboarding feature group is not configured; the /auth
    // router answers 503 in that case.
    shopifyOauth,
    // null when unset: OAuth installs leave proxy_hostname NULL.
    proxyHostnameSuffix,
  };
}
