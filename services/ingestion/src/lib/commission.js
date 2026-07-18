/**
 * lib/commission.js — integer-cents money math for AOP's 0.5% GMV commission.
 *
 * Role in the AOP data flow:
 *   When a Shopify order-created webhook is reconciled against an agent
 *   intent, the order's GMV lands in reconciled_agent_orders and PostgreSQL
 *   computes the commission in a STORED GENERATED column:
 *       commission_fee = round(gross_merchandise_value * commission_rate, 2)
 *   THE DATABASE COLUMN IS AUTHORITATIVE FOR BILLING. This module exists for
 *   everything around it: pre-insert verification, dashboard/report math,
 *   loss-diagnostics revenue estimates, and reconciliation sanity checks.
 *   Its rounding therefore mirrors the DB exactly (round-half-up at cent
 *   precision) so a verification pass never flags phantom drift.
 *
 * Why integer cents + BigInt:
 *   IEEE-754 floats cannot represent most decimal money values (0.1 + 0.2 !==
 *   0.3), and at billing scale the drift is real: 19.99 * 0.005 in float is
 *   0.09994999999999999. All arithmetic here is exact integer math on cents;
 *   BigInt is used for the multiply-then-divide so even a NUMERIC(12,2)-max
 *   GMV (999,999,999,999 cents) times a micro-scaled rate cannot lose
 *   precision to the 2^53 safe-integer ceiling.
 *
 * PURE module: no express/pg imports, no I/O — unit-tested pre-`npm install`
 * by test/commission.test.mjs.
 */

/**
 * Ceiling matching the DB money columns: NUMERIC(12,2) tops out at
 * 9,999,999,999.99, i.e. 999,999,999,999 cents. Anything above is either
 * corrupt input or would be rejected by PostgreSQL anyway, so we surface it
 * as "unparseable" (null) rather than letting an insert fail later.
 */
export const MAX_MONEY_CENTS = 999_999_999_999;

/** Platform default: flat 0.5% of GMV (mirrors the DB column default 0.00500). */
export const DEFAULT_COMMISSION_RATE = 0.005;

/**
 * Parse a Shopify-style decimal money string (e.g. total_price: "19.99") into
 * integer cents, exactly — the digits are processed as text so no float ever
 * enters the pipeline.
 *
 * Accepts: "19.99", "1234.5" (=> 123450), "10" (=> 1000), "  7.25  "
 * (whitespace-tolerant), an optional leading "+", and — defensively — plain
 * finite non-negative numbers (some upstream serializers emit numbers).
 * Fractional digits beyond 2 are rounded HALF-UP at cent precision (Shopify
 * sends 2dp, but currencies with exotic minor units or buggy apps may not).
 *
 * Rejects (returns null, never throws): negative values (an order total is
 * never negative; refunds arrive via different webhooks), thousands
 * separators, currency symbols, exponent notation, values above
 * MAX_MONEY_CENTS, and any non-numeric garbage.
 *
 * @param {unknown} input
 * @returns {number|null} integer cents, or null when unparseable/out-of-range.
 */
export function parseMoneyToCents(input) {
  try {
    let text;
    if (typeof input === 'number') {
      // Defensive numeric path. String(1e21) === "1e+21" fails the regex
      // below, so absurd magnitudes are rejected rather than misparsed.
      if (!Number.isFinite(input) || input < 0) return null;
      text = String(input);
    } else if (typeof input === 'string') {
      text = input.trim();
    } else {
      return null;
    }

    const match = /^\+?(\d+)(?:\.(\d+))?$/.exec(text);
    if (match === null) return null;

    const whole = match[1];
    const frac = match[2] ?? '';

    // Length guard before BigInt: a 10,000-digit "number" is a DoS attempt,
    // not money. 15 whole digits already exceeds MAX_MONEY_CENTS.
    if (whole.length > 15 || frac.length > 64) return null;

    let cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));

    // Round HALF-UP using only the third fractional digit. This is exact for
    // non-negative decimals: digits beyond the third can never lift a "4x..."
    // remainder to >= .5 of a cent (0.4999... < 0.5), and any "5x..." third
    // digit already means >= .5 of a cent.
    if (frac.length > 2 && frac.charCodeAt(2) >= 0x35 /* '5' */) {
      cents += 1n;
    }

    if (cents > BigInt(MAX_MONEY_CENTS)) return null;
    return Number(cents);
  } catch {
    return null; // BigInt() on hostile inputs, etc. — contract: never throws
  }
}

/**
 * Compute the platform commission on a GMV amount, in integer cents.
 *
 * Mirrors the DB generated column exactly: round-half-up at cent precision.
 * The rate is scaled to integer micro-units (parts-per-million) so the only
 * float operation is Math.round(rate * 1e6) on the RATE — a small, exactly
 * representable region — never on the money:
 *     commission = floor((gmvCents * rateMicros + 500000) / 1000000)
 * where the +500000 (half of the 1e6 divisor) implements half-up under
 * BigInt's truncating division.
 *
 * Examples (rate 0.005): 1999c ($19.99) -> 10c; 1c ($0.01) -> 0c;
 * 100c ($1.00) -> 1c (the 0.5c half-up case); 999,999,999,999c -> 5,000,000,000c.
 *
 * USED FOR REPORTING/VERIFICATION ONLY — the DB generated column is the
 * single source of truth for what a merchant is actually billed.
 *
 * @param {unknown} gmvCents  non-negative safe integer (cents).
 * @param {unknown} [rate]    commission rate as a fraction, default 0.005.
 *   Must be a finite number in [0, 1] — a >100% "commission" is corrupt input.
 * @returns {number|null} commission in integer cents, or null on invalid input.
 */
export function computeCommissionCents(gmvCents, rate = DEFAULT_COMMISSION_RATE) {
  try {
    if (!Number.isSafeInteger(gmvCents) || gmvCents < 0 || gmvCents > MAX_MONEY_CENTS) return null;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) return null;

    // Micro-scaled rate: 0.005 -> 5000 exactly. Six decimal places matches
    // the DB's NUMERIC(6,5) rate column precision with a digit to spare.
    const rateMicros = BigInt(Math.round(rate * 1_000_000));

    const commission = (BigInt(gmvCents) * rateMicros + 500_000n) / 1_000_000n;
    return Number(commission);
  } catch {
    return null;
  }
}

/**
 * Format integer cents as the "1234.56"-style decimal string that PostgreSQL
 * NUMERIC columns accept — the bridge from this module's integer-cents world
 * to repository inserts (loss_diagnostics.estimated_revenue_lost). String in,
 * string out on the SQL side keeps floats out of the entire money path.
 *
 * @param {unknown} cents non-negative safe integer.
 * @returns {string|null} e.g. 1999 -> "19.99", 5 -> "0.05", 0 -> "0.00";
 *   null on invalid input.
 */
export function formatCentsAsDecimal(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) return null;
  const text = String(cents).padStart(3, '0'); // >= 3 chars so slice below is safe
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}
