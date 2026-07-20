/**
 * format.js — pure display-formatting helpers for the AOP dashboard.
 *
 * Role in the AOP data flow: the /analytics API returns money as decimal
 * STRINGS (never floats — see services/ingestion) and timestamps as ISO
 * strings; these helpers render them for the Loss Diagnosis screen.
 *
 * PURE module (no React, no DOM) so it is unit-testable under plain
 * `node --test` without a browser or bundler.
 */

/**
 * Format a decimal money string ("165220.00") as "$165,220.00".
 * Unparseable input renders as "—" (an analytics dashboard must degrade
 * visibly, never crash a render or show NaN).
 *
 * Optional currency: an ISO-4217 code renders with that currency's symbol;
 * anything else (e.g. the billing API's 'UNSPECIFIED' for pre-currency rows,
 * or a code Intl rejects) renders as a plain grouped number — visibly
 * unlabeled beats a wrong "$".
 *
 * @param {string|number|null|undefined} value
 * @param {string} [currency]
 * @returns {string}
 */
export function formatMoney(value, currency = 'USD') {
  const num = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(num)) return '—';
  const plain = () =>
    num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) return plain();
  try {
    return num.toLocaleString('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch {
    return plain();
  }
}

/**
 * Format a count with thousands separators ("42150" -> "42,150").
 * @param {number|string|null|undefined} value
 * @returns {string}
 */
export function formatCount(value) {
  const num = Number(value);
  if (value === null || value === undefined || !Number.isFinite(num)) return '—';
  return Math.trunc(num).toLocaleString('en-US');
}

/**
 * Format a percentage number (already 0-100 scaled) as "2.0%".
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function formatPct(value) {
  const num = Number(value);
  if (value === null || value === undefined || !Number.isFinite(num)) return '—';
  return `${num.toFixed(1)}%`;
}

/**
 * Render an ISO timestamp as the wireframe's live-stream clock ("08:12:04").
 * Invalid input -> "—".
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function formatClock(iso) {
  const ms = Date.parse(iso ?? '');
  if (Number.isNaN(ms)) return '—';
  return new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
}

/**
 * Human labels for loss reason codes (falls back to the raw code so novel
 * reasons added server-side still render).
 * @param {string} code
 * @returns {string}
 */
export function lossReasonLabel(code) {
  const labels = {
    PRICE_DISCREPANCY: 'Price Discrepancy',
    SHIPPING_LATENCY: 'Delivery Speed',
    STOCK_OUTAGE: 'Stock Outages',
    POLICY_AMBIGUITY: 'Return Clarity',
    PROTOCOL_ERROR: 'Protocol Errors',
    UNKNOWN_DROPOFF: 'Unclassified Drop-off',
    RECONCILED_ORDER: 'Reconciled Order',
  };
  return labels[code] ?? String(code ?? '—');
}
