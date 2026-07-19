/**
 * routing-config.test.mjs — PROXY_HOSTNAME_SUFFIX validation in loadConfig.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const BASE = { DATABASE_URL: 'x', INGEST_API_TOKEN: 'y', SHOPIFY_WEBHOOK_SECRET: 'z' };

test('PROXY_HOSTNAME_SUFFIX defaults to null and accepts a dotted suffix', () => {
  assert.equal(loadConfig(BASE).proxyHostnameSuffix, null);
  assert.equal(loadConfig({ ...BASE, PROXY_HOSTNAME_SUFFIX: '.agents.AOP.network' }).proxyHostnameSuffix, '.agents.aop.network');
});

test('a malformed suffix fails the boot', () => {
  assert.throws(() => loadConfig({ ...BASE, PROXY_HOSTNAME_SUFFIX: 'no-leading-dot' }), /PROXY_HOSTNAME_SUFFIX/);
});
