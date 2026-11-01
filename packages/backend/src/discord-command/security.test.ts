import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  MemoryReplayGuard,
  signInvokeHmac,
  verifyDiscordSignature,
  verifyInvokeHmac,
} from './security.js';

function ed25519Fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  return {
    publicKeyHex,
    sign(timestamp: string, body: string) {
      return sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString('hex');
    },
  };
}

describe('Discord Ed25519 signatures', () => {
  it('accepts a fixture signed with the application public key', () => {
    const keys = ed25519Fixture();
    const timestamp = '1700000000';
    const body = '{"type":1}';
    const result = verifyDiscordSignature({
      publicKeyHex: keys.publicKeyHex,
      timestamp,
      body,
      signatureHex: keys.sign(timestamp, body),
      nowMs: 1_700_000_000_000,
    });
    assert.deepEqual(result, { ok: true });
  });

  it('rejects an invalid signature', () => {
    const keys = ed25519Fixture();
    const timestamp = '1700000000';
    const body = '{"type":1}';
    const result = verifyDiscordSignature({
      publicKeyHex: keys.publicKeyHex,
      timestamp,
      body,
      signatureHex: keys.sign(timestamp, '{"type":2}'),
      nowMs: 1_700_000_000_000,
    });
    assert.deepEqual(result, { ok: false, code: 'invalid_signature' });
  });

  it('rejects a captured Discord signature after the timestamp window', () => {
    const keys = ed25519Fixture();
    const timestamp = '1700000000';
    const body = '{"type":1}';
    const result = verifyDiscordSignature({
      publicKeyHex: keys.publicKeyHex,
      timestamp,
      body,
      signatureHex: keys.sign(timestamp, body),
      nowMs: 1_700_000_000_000 + 120_000,
      maxAgeMs: 60_000,
    });
    assert.deepEqual(result, { ok: false, code: 'replay' });
  });
});

describe('invoke HMAC and replay guard', () => {
  it('accepts a signed timestamped body once', () => {
    const secret = 'instance-secret';
    const timestamp = '1700000000';
    const nonce = 'n1';
    const body = '{"command":"ts.help"}';
    const signatureHex = signInvokeHmac({ secret, timestamp, nonce, body });
    const replay = new MemoryReplayGuard();
    const result = verifyInvokeHmac({
      secret, timestamp, nonce, body, signatureHex, replay, nowMs: 1_700_000_000_000,
    });
    assert.deepEqual(result, { ok: true });
  });

  it('rejects a wrong HMAC', () => {
    const replay = new MemoryReplayGuard();
    const result = verifyInvokeHmac({
      secret: 'instance-secret',
      timestamp: '1700000000',
      nonce: 'n1',
      body: '{"command":"ts.help"}',
      signatureHex: createHmac('sha256', 'other').update('x').digest('hex'),
      replay,
      nowMs: 1_700_000_000_000,
    });
    assert.deepEqual(result, { ok: false, code: 'invalid_signature' });
  });

  it('rejects a reused nonce as replay', () => {
    const secret = 'instance-secret';
    const timestamp = '1700000000';
    const nonce = 'n1';
    const body = '{"command":"ts.help"}';
    const signatureHex = signInvokeHmac({ secret, timestamp, nonce, body });
    const replay = new MemoryReplayGuard();
    const first = verifyInvokeHmac({
      secret, timestamp, nonce, body, signatureHex, replay, nowMs: 1_700_000_000_000,
    });
    const second = verifyInvokeHmac({
      secret, timestamp, nonce, body, signatureHex, replay, nowMs: 1_700_000_000_100,
    });
    assert.equal(first.ok, true);
    assert.deepEqual(second, { ok: false, code: 'replay' });
  });
});
