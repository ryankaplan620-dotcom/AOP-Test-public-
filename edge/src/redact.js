/**
 * redact.js — PII redaction for AOP intent telemetry (compliance layer).
 *
 * Role in the AOP data flow:
 *   [edge proxy fetch()] -> buildTelemetryRecord() -> redactPii() -> queue.
 *
 * Why this exists (Legal/Compliance memo, "Agent Data Privacy"):
 * ACP/AP2 agents routinely pass consumer PII in POST /shipping_quote payloads
 * (full shipping addresses, names, emails) so origins can quote taxes and
 * delivery dates. AOP is a pass-through analytics processor: PII may transit
 * worker RAM for the milliseconds needed to proxy the request, but it MUST
 * NOT be written to any durable store (queue -> ingestion -> PostgreSQL).
 * This module strips names, street addresses, emails and phone numbers from
 * the captured payload BEFORE it is handed to the queue, retaining only the
 * coarse geographic fields analytics actually needs: postal/zip code,
 * state/province, and country.
 *
 * Two independent redaction passes (defense in depth):
 *   1. KEY-BASED: any object key that names a PII field (name, email, phone,
 *      address lines, city, company, coordinates, ...) has its value replaced
 *      with the "[REDACTED]" sentinel — regardless of what the value looks
 *      like. Keys on the geographic allowlist (zip, postal_code, province,
 *      state, country, ...) are always kept as-is.
 *   2. VALUE-BASED: every surviving string is scrubbed for things that LOOK
 *      like emails, phone numbers, or street addresses, catching PII hiding
 *      under unanticipated keys (e.g. a free-text "notes" field).
 *
 * HARD INVARIANT (same as the rest of the telemetry path): never throws.
 * Any internal failure degrades to dropping the payload entirely — losing a
 * body snapshot is acceptable; leaking PII to disk is not.
 */

/** Sentinel written in place of key-redacted values. */
export const REDACTED = '[REDACTED]';

/**
 * Keys whose values are ALWAYS kept verbatim — the coarse geo granularity the
 * compliance memo explicitly permits for analytics ("retain only Zip
 * Code/State"). Matched on the normalized (lowercased, de-underscored) key.
 */
const GEO_ALLOWLIST = new Set([
  'zip',
  'zipcode',
  'postalcode',
  'postcode',
  'state',
  'statecode',
  'province',
  'provincecode',
  'region',
  'regioncode',
  'country',
  'countrycode',
]);

/**
 * Keys whose values are PII by definition and are replaced with REDACTED.
 * Matched on the normalized key. "city" is redacted deliberately: the memo's
 * allowlist is zip/state only, and zip already gives finer-grained analytics.
 */
const PII_KEYS = new Set([
  'name',
  'firstname',
  'lastname',
  'fullname',
  'customername',
  'recipient',
  'recipientname',
  'email',
  'emailaddress',
  'phone',
  'phonenumber',
  'telephone',
  'mobile',
  'address',
  'address1',
  'address2',
  'street',
  'streetaddress',
  'line1',
  'line2',
  // Canonical street-line field names of the two supported protocols —
  // ACP checkout sessions use line_one/line_two, AP2 (W3C PaymentRequest
  // ContactAddress) uses address_line / addressLine (an ARRAY of lines;
  // key-redaction replaces the whole array). normalizeKey folds the
  // underscore variants onto these.
  'lineone',
  'linetwo',
  'addressline',
  'addresslines',
  'city',
  'company',
  'organization',
  'latitude',
  'longitude',
  'lat',
  'lng',
  'lon',
  'ip',
  'ipaddress',
  'useragentemail',
]);

/** Normalize an object key for matching: lowercase, strip _ - and spaces. */
function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Value-based scrub patterns, applied to every string that survives key-based
 * redaction. Deliberately conservative: better to over-redact a merchant note
 * than to persist a consumer's identity.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone: international/US-style sequences of 7+ digits with separators.
// Requires a digit-dense shape so SKUs like "SKU-99-8822" are not mangled:
// the pattern must start with +, ( or a digit and contain no letters.
const PHONE_RE = /(?:(?<![\w-])\+?\(?\d{1,4}\)?[\s.-]?\d{3}[\s.-]?\d{2,4}[\s.-]?\d{2,4})(?![\w-])/g;
// Street address: house number + 1-3 words + street-type suffix.
// e.g. "123 Main St", "9 Elm Grove Avenue", "77 Rue de Rivoli".
const STREET_RE =
  /\b\d{1,6}\s+(?:[A-Za-z'.-]+\s+){0,3}(?:st(?:reet)?|ave(?:nue)?|r(?:oa)?d|blvd|boulevard|ln|lane|dr(?:ive)?|ct|court|pl(?:ace)?|way|terrace|rue|strasse|straße)\b\.?/gi;

/**
 * Scrub PII-looking substrings out of a free-text string.
 * @param {string} value
 * @returns {{value: string, hits: number}}
 */
function scrubString(value) {
  let hits = 0;
  const scrubbed = value
    .replace(EMAIL_RE, () => {
      hits += 1;
      return '[REDACTED_EMAIL]';
    })
    .replace(STREET_RE, () => {
      hits += 1;
      return '[REDACTED_ADDRESS]';
    })
    .replace(PHONE_RE, (match) => {
      // Ignore short digit runs (order ids, quantities) — only redact shapes
      // with at least 7 digits total, the minimum for a dialable number.
      const digits = match.replace(/\D/g, '');
      if (digits.length < 7) return match;
      hits += 1;
      return '[REDACTED_PHONE]';
    });
  return { value: scrubbed, hits };
}

/** Recursion depth cap — JSON.parse output is acyclic but agents control its
 * shape; a 64-level bound makes pathological nesting a non-issue. */
const MAX_DEPTH = 64;

function redactValue(value, depth, counter) {
  if (depth > MAX_DEPTH) return null; // drop absurdly deep subtrees outright

  if (typeof value === 'string') {
    const { value: scrubbed, hits } = scrubString(value);
    counter.hits += hits;
    return scrubbed;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1, counter));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalized = normalizeKey(key);
      if (GEO_ALLOWLIST.has(normalized)) {
        // Coarse geo is the one thing we are allowed to keep — but only when
        // the VALUE actually looks like a geo token. An allowlisted key must
        // not become a smuggling channel ("state": "john@x.com 555-0100"):
        // real zip/state/country values are short and pass the same
        // value-based scrub as everything else, so anything the scrubber
        // flags (or an implausibly long value) is redacted, not kept.
        if (typeof entry === 'string') {
          const { hits } = scrubString(entry);
          if (hits > 0 || entry.length > 64) {
            counter.hits += 1;
            out[key] = REDACTED;
          } else {
            out[key] = entry;
          }
        } else if (typeof entry === 'object' && entry !== null) {
          out[key] = redactValue(entry, depth + 1, counter);
        } else {
          out[key] = entry;
        }
        continue;
      }
      if (PII_KEYS.has(normalized)) {
        // "address" is a CONTAINER in ACP/AP2 payloads: its children carry
        // both street lines (PII, redacted by their own keys) and the geo
        // fields the memo allows (zip/state/country). Walking it preserves
        // the allowed granularity; a blanket REDACTED would destroy it.
        // Every other PII key (names, emails, address_line ARRAYS of street
        // strings, ...) is redacted wholesale — walking those could leak
        // free-text fragments the value scrubber cannot recognize.
        if (normalized === 'address' && entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          out[key] = redactValue(entry, depth + 1, counter);
          continue;
        }
        counter.hits += 1;
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactValue(entry, depth + 1, counter);
    }
    return out;
  }
  // number | boolean | null — nothing identifying to strip.
  return value;
}

/**
 * Redact PII from a parsed telemetry payload.
 *
 * @param {unknown} payload the JSON.parse()d body snapshot (or null).
 * @returns {{payload: unknown, redactions: number}} the redacted copy (the
 *   input is never mutated) and how many redactions were applied — persisted
 *   on the telemetry record for compliance auditability. On ANY internal
 *   failure returns {payload: null, redactions: -1}: dropping the snapshot is
 *   the fail-safe, persisting un-redacted PII is never an option.
 */
export function redactPii(payload) {
  try {
    if (payload === null || payload === undefined) {
      return { payload: null, redactions: 0 };
    }
    const counter = { hits: 0 };
    const redacted = redactValue(payload, 0, counter);
    return { payload: redacted, redactions: counter.hits };
  } catch {
    return { payload: null, redactions: -1 };
  }
}

/**
 * Redact PII from a URL query string ("?a=b&c=d", as URL.search returns it).
 *
 * The body snapshot goes through redactPii, but agents also put PII in
 * QUERY PARAMETERS (GET /shipping_quote?email=...&address1=...), and the
 * query was previously recorded verbatim — a straight bypass of the
 * compliance layer. Same two passes as the body: PII-named keys drop their
 * value, surviving values get the string scrub. Geo-allowlisted keys keep
 * plausible geo values (same smuggling guard as objects).
 *
 * @param {string|null|undefined} search  URL.search ('' when absent).
 * @returns {{query: string, redactions: number}} re-serialized query
 *   (leading '?' preserved when non-empty). On ANY failure returns
 *   {query: '', redactions: -1} — dropping the query is the fail-safe.
 */
export function redactQueryString(search) {
  try {
    if (typeof search !== 'string' || search === '' || search === '?') {
      return { query: '', redactions: 0 };
    }
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    let redactions = 0;
    const out = new URLSearchParams();
    for (const [key, value] of params) {
      const normalized = normalizeKey(key);
      if (PII_KEYS.has(normalized)) {
        redactions += 1;
        out.append(key, REDACTED);
        continue;
      }
      if (GEO_ALLOWLIST.has(normalized)) {
        const { hits } = scrubString(value);
        if (hits > 0 || value.length > 64) {
          redactions += 1;
          out.append(key, REDACTED);
        } else {
          out.append(key, value);
        }
        continue;
      }
      const { value: scrubbed, hits } = scrubString(value);
      redactions += hits;
      out.append(key, scrubbed);
    }
    const serialized = out.toString();
    return { query: serialized === '' ? '' : `?${serialized}`, redactions };
  } catch {
    return { query: '', redactions: -1 };
  }
}

/**
 * EU/EEA (+UK/CH) country codes for data-residency routing. Telemetry records
 * from these jurisdictions are flagged so the pipeline can route/segregate
 * them onto EU infrastructure (memo: "if X-User-Geo is EU, logs must be
 * routed to Frankfurt, not US-East-1").
 */
const EU_DATA_REGION_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH',
]);

/**
 * Classify a 2-letter country code into a data-residency region.
 * @param {string|null|undefined} countryCode
 * @returns {'eu'|'row'|null} 'eu' -> must be stored on EU infrastructure;
 *   'row' (rest of world) -> default region; null -> geo unknown.
 */
export function dataResidencyRegion(countryCode) {
  try {
    if (typeof countryCode !== 'string') return null;
    const normalized = countryCode.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(normalized)) return null;
    return EU_DATA_REGION_COUNTRIES.has(normalized) ? 'eu' : 'row';
  } catch {
    return null;
  }
}
