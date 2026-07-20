/**
 * lib/csv.js — RFC 4180 CSV serialization for the /analytics export routes.
 *
 * Role in the AOP data flow:
 *   [repositories analytics reads] -> routes/analytics.js export endpoints
 *   -> THIS MODULE -> text/csv download the merchant opens in a spreadsheet.
 *
 * Two safety properties, both load-bearing:
 *   - RFC 4180 quoting: any field containing a comma, quote, CR or LF is
 *     double-quote wrapped with internal quotes doubled — a hostile SKU or
 *     loss detail can never smuggle extra columns/rows into the file.
 *   - Spreadsheet formula-injection guard: fields beginning with '=', '+',
 *     '-', '@', TAB or CR are prefixed with a single quote. Excel/Sheets
 *     otherwise EXECUTE such cells (classic CSV-injection: a product named
 *     "=HYPERLINK(...)" runs when the merchant opens their own export).
 *     The prefix renders as a literal in every major spreadsheet app; data
 *     fidelity is preserved for programmatic consumers because numbers and
 *     nulls are never prefixed (only strings that start with a trigger).
 *
 * PURE module: no express/pg imports — unit-tested by test/csv.test.mjs.
 */

/** Leading characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Serialize one field. null/undefined -> empty; numbers/booleans verbatim;
 * strings guarded (formula prefix) then quoted (RFC 4180) when needed.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function csvField(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  let text = value instanceof Date ? value.toISOString() : String(value);
  if (text.length > 0 && FORMULA_TRIGGERS.has(text[0])) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Serialize rows to a CSV document (CRLF line endings per RFC 4180).
 *
 * @param {Array<object>} rows
 * @param {Array<{key: string, header: string}>} columns ordered column spec;
 *   headers are emitted first and pass through csvField too.
 * @returns {string}
 */
export function toCsv(rows, columns) {
  const lines = [columns.map((c) => csvField(c.header)).join(',')];
  for (const row of rows ?? []) {
    lines.push(columns.map((c) => csvField(row?.[c.key])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
