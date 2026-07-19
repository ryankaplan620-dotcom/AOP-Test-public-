/**
 * intent-classifier.test.mjs — unit tests for Context Reconstruction
 * (src/lib/intent-classifier.js). Pure; passes before npm install.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntentContext, INTENT_CATEGORIES } from '../src/lib/intent-classifier.js';

test('explicit on-taxonomy tags pass through (case/separator-insensitive)', () => {
  assert.deepEqual(classifyIntentContext({ intent_category: 'price_sensitive' }), {
    category: 'PRICE_SENSITIVE',
    source: 'intent_category',
  });
  assert.equal(classifyIntentContext({ user_intent_category: 'Gift-Urgent' }).category, 'GIFT_URGENT');
  assert.equal(
    classifyIntentContext({ agent_identity: { user_intent_category: 'ECO_CONSCIOUS' } }).category,
    'ECO_CONSCIOUS',
  );
});

test('off-taxonomy tags fall through to text heuristics', () => {
  // The product docs' mock event shape: "gift_shopping_urgent".
  const result = classifyIntentContext({
    agent_identity: { user_intent_category: 'gift_shopping_urgent' },
  });
  assert.equal(result.category, 'GIFT_URGENT');
});

test('free-text prompts classify across the taxonomy', () => {
  const cases = [
    ['need an anniversary gift delivered by tomorrow', 'GIFT_URGENT'],
    ['birthday present for my sister', 'GIFT'],
    ['cheapest eco-friendly detergent', 'PRICE_SENSITIVE'], // price outranks eco in rule order
    ['sustainable organic cotton shirt', 'ECO_CONSCIOUS'],
    ['best quality leather boots that are durable', 'QUALITY_FOCUSED'],
    ['reorder the same coffee beans again', 'REPLENISHMENT'],
    ['comparing options and reviews for standing desks', 'RESEARCH'],
  ];
  for (const [prompt, expected] of cases) {
    assert.equal(classifyIntentContext({ prompt }).category, expected, prompt);
  }
});

test('context present but unmatched -> UNCLASSIFIED; no context at all -> null', () => {
  assert.deepEqual(classifyIntentContext({ prompt: 'blue size medium' }), {
    category: 'UNCLASSIFIED',
    source: 'unmatched_context',
  });
  assert.equal(classifyIntentContext({ items: [{ sku: 'X' }] }), null);
  assert.equal(classifyIntentContext(null), null);
  assert.equal(classifyIntentContext('a string'), null);
});

test('never throws on hostile shapes and bounds long text', () => {
  const hostile = {
    get prompt() {
      throw new Error('boom');
    },
  };
  assert.equal(classifyIntentContext(hostile), null);
  const long = { prompt: `${'x'.repeat(50_000)} birthday gift` };
  // Keyword beyond the 2KB scan bound must NOT match — bounded work, and the
  // context still counts as seen.
  assert.equal(classifyIntentContext(long).category, 'UNCLASSIFIED');
});

test('taxonomy is closed and stable', () => {
  assert.equal(INTENT_CATEGORIES.length, 8);
  assert.ok(INTENT_CATEGORIES.includes('UNCLASSIFIED'));
});
