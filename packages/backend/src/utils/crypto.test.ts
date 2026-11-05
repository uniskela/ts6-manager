import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { config } from '../config.js';
import { decrypt, encrypt } from './crypto.js';

const SALT = 'ts6-webui-enc-v1';

function partsOf(blob: string): [string, string, string, string] {
  const parts = blob.split(':');
  assert.equal(parts.length, 4);
  return parts as [string, string, string, string];
}

function withTag(blob: string, tag: Buffer): string {
  const [prefix, iv, , ciphertext] = partsOf(blob);
  return `${prefix}:${iv}:${tag.toString('hex')}:${ciphertext}`;
}

function withCiphertext(blob: string, ciphertext: Buffer): string {
  const [prefix, iv, tag] = partsOf(blob);
  return `${prefix}:${iv}:${tag}:${ciphertext.toString('hex')}`;
}

function withPart(blob: string, index: 1 | 2 | 3, value: string): string {
  const parts = partsOf(blob);
  parts[index] = value;
  return parts.join(':');
}

/** Ciphertext produced the way encrypt() did before authTagLength was set. */
function encryptWithoutAuthTagLength(plaintext: string): string {
  const source = process.env.ENCRYPTION_KEY || config.jwtSecret;
  const key = scryptSync(source, SALT, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

describe('field encryption AES-256-GCM', () => {
  it('round-trips valid ciphertext with a 16-byte tag', () => {
    const blob = encrypt('secret-api-key');
    assert.match(blob, /^enc:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    assert.equal(decrypt(blob), 'secret-api-key');
  });

  it('decrypts ciphertext produced without an explicit authTagLength option', () => {
    const blob = encryptWithoutAuthTagLength('legacy-secret');
    assert.match(blob, /^enc:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    assert.equal(decrypt(blob), 'legacy-secret');
  });

  it('leaves plaintext values unchanged for migration', () => {
    assert.equal(decrypt('not-yet-encrypted'), 'not-yet-encrypted');
  });

  it('rejects modified ciphertext', () => {
    const blob = encrypt('secret');
    const [, , , ctHex] = partsOf(blob);
    const ct = Buffer.from(ctHex, 'hex');
    ct[0] ^= 1;
    assert.throws(() => decrypt(withCiphertext(blob, ct)));
  });

  it('rejects a modified authentication tag', () => {
    const blob = encrypt('secret');
    const [, , tagHex] = partsOf(blob);
    const tag = Buffer.from(tagHex, 'hex');
    tag[0] ^= 1;
    assert.throws(() => decrypt(withTag(blob, tag)));
  });

  it('rejects a truncated 12-byte authentication tag', () => {
    const blob = encrypt('secret');
    const [, , tagHex] = partsOf(blob);
    assert.throws(() => decrypt(withTag(blob, Buffer.from(tagHex, 'hex').subarray(0, 12))));
  });

  it('rejects a truncated 4-byte authentication tag', () => {
    const blob = encrypt('secret');
    const [, , tagHex] = partsOf(blob);
    assert.throws(() => decrypt(withTag(blob, Buffer.from(tagHex, 'hex').subarray(0, 4))));
  });

  it('rejects an oversized authentication tag', () => {
    const blob = encrypt('secret');
    const [, , tagHex] = partsOf(blob);
    const tag = Buffer.concat([Buffer.from(tagHex, 'hex'), Buffer.from([0])]);
    assert.throws(() => decrypt(withTag(blob, tag)));
  });

  it('rejects an empty authentication tag', () => {
    const blob = encrypt('secret');
    assert.throws(() => decrypt(withTag(blob, Buffer.alloc(0))));
  });

  it('round-trips empty plaintext with empty ciphertext', () => {
    const blob = encrypt('');
    assert.match(blob, /^enc:[0-9a-f]{24}:[0-9a-f]{32}:$/);
    assert.equal(decrypt(blob), '');
  });

  it('rejects an IV with a non-hex suffix', () => {
    const blob = encrypt('secret');
    const [, ivHex] = partsOf(blob);
    assert.throws(() => decrypt(withPart(blob, 1, `${ivHex}zz`)), /Invalid encrypted format/);
  });

  it('rejects an IV with an extra hex character', () => {
    const blob = encrypt('secret');
    const [, ivHex] = partsOf(blob);
    assert.throws(() => decrypt(withPart(blob, 1, `${ivHex}a`)), /Invalid encrypted format/);
  });

  it('rejects an authentication tag with a non-hex suffix', () => {
    const blob = encrypt('secret');
    const [, , tagHex] = partsOf(blob);
    assert.throws(() => decrypt(withPart(blob, 2, `${tagHex}zz`)), /Invalid encrypted format/);
  });

  it('rejects an authentication tag with an extra hex character', () => {
    const blob = encrypt('secret');
    const [, , tagHex] = partsOf(blob);
    assert.throws(() => decrypt(withPart(blob, 2, `${tagHex}a`)), /Invalid encrypted format/);
  });

  it('rejects ciphertext with a non-hex suffix', () => {
    const blob = encrypt('secret');
    const [, , , ctHex] = partsOf(blob);
    assert.throws(() => decrypt(withPart(blob, 3, `${ctHex}zz`)), /Invalid encrypted format/);
  });

  it('rejects odd-length ciphertext', () => {
    const blob = encrypt('secret');
    const [, , , ctHex] = partsOf(blob);
    assert.throws(() => decrypt(withPart(blob, 3, `${ctHex}a`)), /Invalid encrypted format/);
  });

  it('rejects ciphertext with interior non-hex characters', () => {
    const blob = encrypt('secret');
    const [, , , ctHex] = partsOf(blob);
    assert.throws(
      () => decrypt(withPart(blob, 3, `${ctHex.slice(0, 2)}zz${ctHex.slice(2)}`)),
      /Invalid encrypted format/,
    );
  });
});
