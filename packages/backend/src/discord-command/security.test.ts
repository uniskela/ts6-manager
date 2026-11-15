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
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.timestampMs, 1_700_000_000_000);
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
  const secret = 'instance-secret';
  const body = '{"command":"ts.help"}';
  const maxAgeMs = 60_000;

  function signed(timestamp: string, nonce: string) {
    return signInvokeHmac({ secret, timestamp, nonce, body });
  }

  it('accepts a signed timestamped body once', () => {
    const timestamp = '1700000000';
    const nonce = 'n1';
    const replay = new MemoryReplayGuard(maxAgeMs);
    const result = verifyInvokeHmac({
      secret, timestamp, nonce, body, signatureHex: signed(timestamp, nonce),
      replay, nowMs: 1_700_000_000_000, maxAgeMs,
    });
    assert.deepEqual(result, { ok: true });
  });

  it('rejects a wrong HMAC without reserving the nonce', () => {
    const timestamp = '1700000000';
    const nonce = 'n-bad-sig';
    const replay = new MemoryReplayGuard(maxAgeMs);
    const bad = verifyInvokeHmac({
      secret,
      timestamp,
      nonce,
      body,
      signatureHex: createHmac('sha256', 'other').update('x').digest('hex'),
      replay,
      nowMs: 1_700_000_000_000,
      maxAgeMs,
    });
    assert.deepEqual(bad, { ok: false, code: 'invalid_signature' });
    const good = verifyInvokeHmac({
      secret, timestamp, nonce, body, signatureHex: signed(timestamp, nonce),
      replay, nowMs: 1_700_000_000_000, maxAgeMs,
    });
    assert.deepEqual(good, { ok: true });
  });

  it('rejects a reused nonce as replay', () => {
    const timestamp = '1700000000';
    const nonce = 'n1';
    const signatureHex = signed(timestamp, nonce);
    const replay = new MemoryReplayGuard(maxAgeMs);
    const first = verifyInvokeHmac({
      secret, timestamp, nonce, body, signatureHex, replay, nowMs: 1_700_000_000_000, maxAgeMs,
    });
    const second = verifyInvokeHmac({
      secret, timestamp, nonce, body, signatureHex, replay, nowMs: 1_700_000_000_100, maxAgeMs,
    });
    assert.equal(first.ok, true);
    assert.deepEqual(second, { ok: false, code: 'replay' });
  });

  it('rejects expired and excessively future-dated timestamps', () => {
    const replay = new MemoryReplayGuard(maxAgeMs);
    const nowMs = 1_700_000_000_000;
    const expired = verifyInvokeHmac({
      secret,
      timestamp: '1699999900',
      nonce: 'n-expired',
      body,
      signatureHex: signed('1699999900', 'n-expired'),
      replay,
      nowMs,
      maxAgeMs,
    });
    assert.deepEqual(expired, { ok: false, code: 'replay' });

    const futureTs = String(Math.floor((nowMs + maxAgeMs + 1_000) / 1000));
    const future = verifyInvokeHmac({
      secret,
      timestamp: futureTs,
      nonce: 'n-future',
      body,
      signatureHex: signed(futureTs, 'n-future'),
      replay,
      nowMs,
      maxAgeMs,
    });
    assert.deepEqual(future, { ok: false, code: 'replay' });
  });

  it('rejects malformed timestamps', () => {
    const replay = new MemoryReplayGuard(maxAgeMs);
    for (const timestamp of ['', 'nope', '1700000000.5', '0x64', '1e9', '-1']) {
      const nonce = `n-malformed-${timestamp || 'empty'}`;
      const result = verifyInvokeHmac({
        secret,
        timestamp,
        nonce,
        body,
        signatureHex: signInvokeHmac({ secret, timestamp, nonce, body }),
        replay,
        nowMs: 1_700_000_000_000,
        maxAgeMs,
      });
      assert.deepEqual(result, { ok: false, code: 'replay' }, timestamp);
    }
  });

  it('keeps independent legitimate requests independent', () => {
    const replay = new MemoryReplayGuard(maxAgeMs);
    const a = verifyInvokeHmac({
      secret, timestamp: '1700000000', nonce: 'n-a', body, signatureHex: signed('1700000000', 'n-a'),
      replay, nowMs: 1_700_000_000_000, maxAgeMs,
    });
    const b = verifyInvokeHmac({
      secret, timestamp: '1700000000', nonce: 'n-b', body, signatureHex: signed('1700000000', 'n-b'),
      replay, nowMs: 1_700_000_000_000, maxAgeMs,
    });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
  });

  it('executes concurrent identical envelopes at most once', async () => {
    const timestamp = '1700000000';
    const nonce = 'n-concurrent';
    const signatureHex = signed(timestamp, nonce);
    const replay = new MemoryReplayGuard(maxAgeMs);
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      verifyInvokeHmac({
        secret, timestamp, nonce, body, signatureHex, replay, nowMs: 1_700_000_000_000, maxAgeMs,
      })));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok && r.code === 'replay').length, 7);
  });

  it('retains a future-dated nonce until signedTs+maxAgeMs (#7)', () => {
    const nowMs = 1_700_000_000_000;
    const signedMs = nowMs + 50_000;
    const timestamp = String(Math.floor(signedMs / 1000));
    const nonce = 'n-future-dated';
    const signatureHex = signed(timestamp, nonce);
    const replay = new MemoryReplayGuard(maxAgeMs);
    const first = verifyInvokeHmac({
      secret, timestamp, nonce, body, signatureHex, replay, nowMs, maxAgeMs,
    });
    assert.equal(first.ok, true);

    // Old bug: nonce expired at receivedAt+ttl while abs() still accepted the stamp.
    const afterReceiveTtl = nowMs + maxAgeMs + 1;
    assert.ok(Math.abs(afterReceiveTtl - signedMs) <= maxAgeMs);
    const second = verifyInvokeHmac({
      secret, timestamp, nonce, body, signatureHex, replay, nowMs: afterReceiveTtl, maxAgeMs,
    });
    assert.deepEqual(second, { ok: false, code: 'replay' });

    const afterValidity = signedMs + maxAgeMs + 1;
    const third = verifyInvokeHmac({
      secret, timestamp, nonce, body, signatureHex, replay, nowMs: afterValidity, maxAgeMs,
    });
    assert.deepEqual(third, { ok: false, code: 'replay' });
  });

  it('fails closed when the bounded replay cache is full', () => {
    const replay = new MemoryReplayGuard(maxAgeMs, 2);
    assert.equal(replay.claim('a', 1_700_000_000_000), true);
    assert.equal(replay.claim('b', 1_700_000_000_000), true);
    assert.equal(replay.claim('c', 1_700_000_000_000), false);
    assert.equal(replay.size(), 2);
  });

  it('protects replay through the inclusive last-valid timestamp', () => {
    const signedMs = 1_700_000_000_000;
    const timestamp = String(Math.floor(signedMs / 1000));
    const nonce = 'n-boundary';
    const signatureHex = signed(timestamp, nonce);
    const replay = new MemoryReplayGuard(maxAgeMs);
    const lastValid = signedMs + maxAgeMs;

    assert.equal(
      verifyInvokeHmac({
        secret, timestamp, nonce, body, signatureHex, replay, nowMs: signedMs, maxAgeMs,
      }).ok,
      true,
    );
    assert.deepEqual(
      verifyInvokeHmac({
        secret, timestamp, nonce, body, signatureHex, replay, nowMs: signedMs + 1, maxAgeMs,
      }),
      { ok: false, code: 'replay' },
    );
    assert.deepEqual(
      verifyInvokeHmac({
        secret, timestamp, nonce, body, signatureHex, replay, nowMs: lastValid - 1, maxAgeMs,
      }),
      { ok: false, code: 'replay' },
    );
    assert.deepEqual(
      verifyInvokeHmac({
        secret, timestamp, nonce, body, signatureHex, replay, nowMs: lastValid, maxAgeMs,
      }),
      { ok: false, code: 'replay' },
      'exact last-valid now must still reject replay',
    );

    // Drop the cache entry as GC would after expiry, then confirm the stamp alone fails closed.
    assert.equal(replay.claim(nonce, lastValid + 1), true, 'nonce may be reused only after expiry');
    assert.deepEqual(
      verifyInvokeHmac({
        secret, timestamp, nonce, body, signatureHex,
        replay: new MemoryReplayGuard(maxAgeMs),
        nowMs: lastValid + 1,
        maxAgeMs,
      }),
      { ok: false, code: 'replay' },
    );
  });
});
