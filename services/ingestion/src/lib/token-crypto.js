/**
 * lib/token-crypto.js — application-layer encryption for merchant OAuth tokens.
 *
 * Role in the AOP data flow:
 *   [Shopify OAuth callback] -> access token (SECRET, grants Admin API access
 *   to the merchant's store) -> encryptToken() -> merchant_profiles.
 *   access_token_encrypted -> decryptToken() only at the moment an Admin API
 *   call is made (e.g. webhook registration at install time).
 *
 * The schema (db migration 0002) mandates that access_token_encrypted holds
 * ciphertext only — THIS module is the implementation of that contract:
 * AES-256-GCM (authenticated encryption: tampering with any ciphertext byte
 * fails decryption outright) with a random 12-byte IV per encryption and the
 * shop domain bound in as AAD, so a ciphertext copied between merchant rows
 * refuses to decrypt.
 *
 * Wire format (versioned for future rotation):
 *   enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 *
 * Key: TOKEN_ENCRYPTION_KEY env var, 64 hex chars (32 bytes). Generate with
 *   openssl rand -hex 32
 *
 * PURE module: node:crypto only — unit-tested pre-`npm install`.
 */

import crypto from 'node:crypto';

/** Format tag; bump on algorithm/layout changes so old rows stay readable. */
const VERSION_PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // NIST-recommended GCM nonce size

/**
 * Parse and validate the encryption key.
 * @param {string} hexKey 64 hex chars.
 * @returns {Buffer} 32-byte key.
 * @throws {Error} on any malformed key — failing loudly at config time beats
 *   silently encrypting with a truncated key.
 */
export function parseEncryptionKey(hexKey) {
  if (typeof hexKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hexKey.trim())) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (openssl rand -hex 32)');
  }
  return Buffer.from(hexKey.trim(), 'hex');
}

/**
 * Encrypt a merchant access token.
 *
 * @param {string} plaintext the OAuth access token.
 * @param {Buffer} key 32-byte key from parseEncryptionKey().
 * @param {string} shopDomain bound as AAD: ciphertext is only valid for THIS
 *   merchant row (lowercased so domain-case differences cannot break decrypt).
 * @returns {string} enc:v1:<iv>:<tag>:<ct> (all base64).
 */
export function encryptToken(plaintext, key, shopDomain) {
  if (typeof plaintext !== 'string' || plaintext === '') {
    throw new Error('cannot encrypt an empty token');
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('encryption key must be a 32-byte Buffer');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(String(shopDomain ?? '').toLowerCase(), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypt a stored token.
 *
 * @param {string} encoded enc:v1:... value from merchant_profiles.
 * @param {Buffer} key 32-byte key.
 * @param {string} shopDomain must match the domain used at encryption time.
 * @returns {string} the plaintext access token.
 * @throws {Error} on wrong version, malformed layout, wrong key, wrong shop
 *   (AAD mismatch), or any tampering — GCM authentication makes all of these
 *   indistinguishable "decryption failed" outcomes, which is exactly right:
 *   no oracle for an attacker probing stored ciphertexts.
 */
export function decryptToken(encoded, key, shopDomain) {
  if (typeof encoded !== 'string' || !encoded.startsWith(VERSION_PREFIX)) {
    throw new Error('unsupported token ciphertext format');
  }
  const parts = encoded.slice(VERSION_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('malformed token ciphertext');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new Error('malformed token ciphertext');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(String(shopDomain ?? '').toLowerCase(), 'utf8'));
  decipher.setAuthTag(tag);
  // decipher.final() throws on ANY authentication failure.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
