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

test('DIGEST_WEBHOOK_URL accepts plain http(s), rejects other protocols', () => {
  assert.equal(loadConfig(BASE).digestWebhookUrl, null);
  assert.equal(
    loadConfig({ ...BASE, DIGEST_WEBHOOK_URL: 'https://hooks.example/digest' }).digestWebhookUrl,
    'https://hooks.example/digest'
  );
  assert.throws(() => loadConfig({ ...BASE, DIGEST_WEBHOOK_URL: 'ftp://hooks.example/x' }), /DIGEST_WEBHOOK_URL/);
});

test('DIGEST_WEBHOOK_URL with embedded credentials fails the boot WITHOUT echoing the secret', () => {
  // fetch() (undici) rejects credentialed URLs unconditionally at request
  // time: accepting this would boot, then fail (and log the password) on
  // every delivery attempt forever. Reject at boot; the error must not
  // contain the secret it exists to protect.
  let thrown = null;
  try {
    loadConfig({ ...BASE, DIGEST_WEBHOOK_URL: 'https://digest:s3cretpw@hooks.example/aop' });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'boot must fail');
  assert.match(thrown.message, /DIGEST_WEBHOOK_URL must not embed credentials/);
  assert.ok(!thrown.message.includes('s3cretpw'), 'secret must not appear in the boot error');
});

test('a MALFORMED credentialed DIGEST_WEBHOOK_URL also fails without echoing the secret', () => {
  // The catch branch used to interpolate the raw value into the error —
  // an operator typo (missing host, stray space) around a credentialed
  // URL would print the password into deploy logs.
  for (const bad of [
    'http://user:s3cretpw@',
    'http://user:s3cretpw@exa mple.com/hook',
    'http://user:s3cretpw@host:99999999999999/hook',
  ]) {
    let thrown = null;
    try {
      loadConfig({ ...BASE, DIGEST_WEBHOOK_URL: bad });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, `boot must fail for ${JSON.stringify(bad).replace('s3cretpw', '***')}`);
    assert.match(thrown.message, /DIGEST_WEBHOOK_URL is invalid/);
    assert.ok(!thrown.message.includes('s3cretpw'), 'secret must not appear in the boot error');
  }
});
