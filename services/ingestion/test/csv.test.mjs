/**
 * test/csv.test.mjs — RFC 4180 quoting + spreadsheet formula-injection guard
 * (lib/csv.js). PURE module suite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvField, toCsv } from '../src/lib/csv.js';

test('csvField quotes commas, quotes, and newlines per RFC 4180', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line1\nline2'), '"line1\nline2"');
  assert.equal(csvField('cr\rhere'), '"cr\rhere"');
});

test('csvField neutralizes spreadsheet formula injection', () => {
  // Classic CSV injection: Excel executes cells starting with = + - @.
  assert.equal(csvField('=HYPERLINK("http://evil","x")'), `"'=HYPERLINK(""http://evil"",""x"")"`);
  assert.equal(csvField('+1234'), "'+1234");
  assert.equal(csvField('-cmd'), "'-cmd");
  assert.equal(csvField('@import'), "'@import");
  // Numbers are NEVER prefixed — negative amounts stay numeric.
  assert.equal(csvField(-12.5), '-12.5');
  assert.equal(csvField(0), '0');
});

test('csvField never guards numeric STRINGS — pg returns NUMERIC/BIGINT as strings', () => {
  // A refund amount arrives from node-postgres as the string "-129.00";
  // an apostrophe prefix would corrupt every negative money value in
  // billing.csv (spreadsheets parse these as numbers, never formulas).
  assert.equal(csvField('-129.00'), '-129.00');
  assert.equal(csvField('-3'), '-3');
  assert.equal(csvField('-1.5e3'), '-1.5e3');
  // Non-numeric leading-trigger strings stay guarded.
  assert.equal(csvField('-2+3'), "'-2+3");
  assert.equal(csvField('-@cmd'), "'-@cmd");
  assert.equal(csvField('-'), "'-");
  assert.equal(csvField('-129.00 USD'), "'-129.00 USD");
  // '+' never opens a pg numeric string; keep it guarded.
  assert.equal(csvField('+123'), "'+123");
});

test('csvField renders null/undefined empty, dates as ISO, booleans as words', () => {
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
  assert.equal(csvField(new Date('2026-07-20T12:00:00Z')), '2026-07-20T12:00:00.000Z');
  assert.equal(csvField(true), 'true');
});

test('toCsv emits header + rows with CRLF endings and stable column order', () => {
  const csv = toCsv(
    [
      { sku: 'TEE,XL', amount: '19.99', note: '=SUM(A1)' },
      { sku: 'HAT', amount: null },
    ],
    [
      { key: 'sku', header: 'sku' },
      { key: 'amount', header: 'amount' },
      { key: 'note', header: 'note' },
    ]
  );
  // Note: the guarded formula cell has no comma/quote/newline, so it needs
  // no RFC 4180 wrapping — the leading apostrophe alone neutralizes it.
  assert.equal(csv, "sku,amount,note\r\n\"TEE,XL\",19.99,'=SUM(A1)\r\nHAT,,\r\n");
});

test('toCsv tolerates empty/missing rows', () => {
  assert.equal(toCsv([], [{ key: 'a', header: 'a' }]), 'a\r\n');
  assert.equal(toCsv(null, [{ key: 'a', header: 'a' }]), 'a\r\n');
});
