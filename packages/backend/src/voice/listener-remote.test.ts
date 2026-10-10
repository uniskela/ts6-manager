import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { ListenerRemoteError, ListenerRemoteService, type Binding } from './listener-remote.js';

const BINDING: Binding = { botId: 1, serverConfigId: 2, virtualServerId: 3, channelId: 4, clid: 5, uid: 'listener-uid' };
const allowed = async (): Promise<boolean> => true;
const expired = (error: unknown): boolean => error instanceof ListenerRemoteError && error.status === 401;
const limited = (error: unknown): boolean => error instanceof ListenerRemoteError && error.status === 429 && error.code === 'rate_limited';

function fixture() {
  let now = 1_000;
  return { service: new ListenerRemoteService(() => now), advance: (ms: number) => { now += ms; } };
}

function pendingValidation() {
  let resolve!: (valid: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { validate: async () => promise, resolve: (valid = true) => resolve(valid) };
}

describe('listener remote credentials and lifetime', () => {
  it('issues unpredictable 256-bit tokens and sessions while storing only their hashes', async () => {
    const { service } = fixture();
    const { token, expiresAt } = service.issue(BINDING);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(expiresAt, 301_000);
    const { session, binding, expiresAt: sessionExpiry } = await service.exchange(token, allowed);
    assert.notEqual(session, token);
    assert.equal(sessionExpiry, 901_000);
    assert.deepEqual(binding, BINDING);
    assert.deepEqual(await service.authenticate(session, allowed), BINDING);
    const state = service as unknown as { grants: Map<string, unknown>; tokens: Map<string, unknown>; sessions: Map<string, unknown> };
    assert.equal(state.tokens.size, 0);
    assert.equal(state.sessions.has(session), false);
    assert.equal(state.sessions.has(createHash('sha256').update(session).digest('hex')), true);
    const stored = JSON.stringify([...state.grants.values()]);
    assert.equal(stored.includes(token), false);
    assert.equal(stored.includes(session), false);
    await assert.rejects(service.exchange(token, allowed), expired);
  });

  it('consumes a token atomically before an asynchronous validation finishes', async () => {
    const { service } = fixture();
    const { token } = service.issue(BINDING);
    const pending = pendingValidation();
    const first = service.exchange(token, pending.validate);
    await assert.rejects(service.exchange(token, allowed), expired);
    pending.resolve();
    assert.deepEqual((await first).binding, BINDING);
  });

  it('never reinstates a token after invalid identity or failed TeamSpeak lookup', async () => {
    for (const validate of [async () => false, async () => { throw new Error('private upstream credentials'); }]) {
      const { service } = fixture();
      const { token } = service.issue(BINDING);
      await assert.rejects(service.exchange(token, validate), (error: unknown) => {
        assert.equal(expired(error), true);
        assert.equal(String(error).includes('private upstream'), false);
        return true;
      });
      await assert.rejects(service.exchange(token, allowed), expired);
    }
  });

  it('expires tokens after five minutes and sessions absolutely after fifteen minutes', async () => {
    const { service, advance } = fixture();
    const old = service.issue(BINDING);
    advance(5 * 60_000);
    await assert.rejects(service.exchange(old.token, allowed), expired);
    const { session } = await service.exchange(service.issue(BINDING).token, allowed);
    advance(14 * 60_000);
    await service.authenticate(session, allowed);
    advance(60_000);
    await assert.rejects(service.authenticate(session, allowed), expired);
  });

  it('rejects expiry while validation is pending without creating a session', async () => {
    const { service, advance } = fixture();
    const pending = pendingValidation();
    const exchange = service.exchange(service.issue(BINDING).token, pending.validate);
    advance(5 * 60_000);
    pending.resolve();
    await assert.rejects(exchange, expired);
    const state = service as unknown as { sessions: Map<string, unknown> };
    assert.equal(state.sessions.size, 0);
  });

  it('binds grants immutably to exactly one bot and TeamSpeak identity', async () => {
    const { service } = fixture();
    const input = { ...BINDING };
    const { token } = service.issue(input);
    input.botId = 90;
    const { session, binding } = await service.exchange(token, async (candidate) => {
      assert.deepEqual(candidate, BINDING);
      candidate.uid = 'changed';
      return true;
    });
    binding.uid = 'also-changed';
    assert.deepEqual(await service.authenticate(session, allowed), BINDING);
    const other = await service.exchange(service.issue({ ...BINDING, botId: 2 }).token, allowed);
    assert.equal(service.revoke(1, 'another-uid'), 0);
    assert.equal(service.revoke(1, BINDING.uid), 1);
    await assert.rejects(service.authenticate(session, allowed), expired);
    await service.authenticate(other.session, allowed);
  });

  it('reissuing access invalidates the earlier token and session', async () => {
    const { service } = fixture();
    const first = service.issue(BINDING);
    const second = service.issue(BINDING);
    await assert.rejects(service.exchange(first.token, allowed), expired);
    const { session } = await service.exchange(second.token, allowed);
    const third = service.issue(BINDING);
    await assert.rejects(service.authenticate(session, allowed), expired);
    await service.exchange(third.token, allowed);
  });

  it('channel departure revokes only the matching TeamSpeak server and client', async () => {
    const { service } = fixture();
    const session = await service.exchange(service.issue(BINDING).token, allowed);
    service.revokeClient(BINDING.serverConfigId + 1, BINDING.virtualServerId, BINDING.clid);
    service.revokeClient(BINDING.serverConfigId, BINDING.virtualServerId + 1, BINDING.clid);
    service.revokeClient(BINDING.serverConfigId, BINDING.virtualServerId, BINDING.clid + 1);
    await service.authenticate(session.session, allowed);
    service.revokeClient(BINDING.serverConfigId, BINDING.virtualServerId, BINDING.clid);
    await assert.rejects(service.authenticate(session.session, allowed), expired);
  });

  it('admin revocation and departure defeat exchanges and authentication already in flight', async () => {
    for (const revoke of [
      (service: ListenerRemoteService) => service.revoke(BINDING.botId),
      (service: ListenerRemoteService) => service.revokeClient(BINDING.serverConfigId, BINDING.virtualServerId, BINDING.clid),
    ]) {
      const { service } = fixture();
      const pendingExchange = pendingValidation();
      const exchange = service.exchange(service.issue(BINDING).token, pendingExchange.validate);
      revoke(service);
      pendingExchange.resolve();
      await assert.rejects(exchange, expired);
      const { session } = await service.exchange(service.issue(BINDING).token, allowed);
      const pendingAuth = pendingValidation();
      const authentication = service.authenticate(session, pendingAuth.validate);
      revoke(service);
      pendingAuth.resolve();
      await assert.rejects(authentication, expired);
    }
  });

  it('old in-flight validation cannot delete a replacement grant', async () => {
    const { service } = fixture();
    const pending = pendingValidation();
    const first = service.exchange(service.issue(BINDING).token, pending.validate);
    const replacement = service.issue(BINDING);
    pending.resolve();
    await assert.rejects(first, expired);
    await service.exchange(replacement.token, allowed);
  });

  it('revokes a session permanently if its listener fails current validation', async () => {
    const { service } = fixture();
    const { session } = await service.exchange(service.issue(BINDING).token, allowed);
    await assert.rejects(service.authenticate(session, async () => false), expired);
    await assert.rejects(service.authenticate(session, allowed), expired);
  });

  it('rejects malformed credentials and invalid server-side bindings', async () => {
    const { service } = fixture();
    for (const value of ['', 'short', 'a'.repeat(44), '/'.repeat(43), null, 4]) {
      await assert.rejects(service.exchange(value as string, allowed), expired);
      await assert.rejects(service.authenticate(value as string, allowed), expired);
    }
    for (const binding of [{ ...BINDING, uid: '' }, { ...BINDING, uid: ' '.repeat(8) }, { ...BINDING, botId: 0 }, { ...BINDING, clid: 1.5 }]) {
      assert.throws(() => service.issue(binding), (error: unknown) => error instanceof ListenerRemoteError && error.status === 400);
    }
  });
});

describe('listener remote bounded rate limits', () => {
  it('limits issuing grants to three per bot/identity/minute, including after revocation', () => {
    const { service, advance } = fixture();
    for (let i = 0; i < 3; i++) {
      service.issue(BINDING);
      service.revoke(BINDING.botId);
    }
    assert.throws(() => service.issue(BINDING), limited);
    service.issue({ ...BINDING, uid: 'another' });
    advance(60_000);
    service.issue(BINDING);
  });

  it('limits token exchanges and session requests without extending their lifetime', async () => {
    const { service, advance } = fixture();
    const { token } = service.issue(BINDING);
    const { session } = await service.exchange(token, allowed);
    for (let i = 0; i < 4; i++) await assert.rejects(service.exchange(token, allowed), expired);
    await assert.rejects(service.exchange(token, allowed), limited);
    for (let i = 0; i < 60; i++) await service.authenticate(session, allowed);
    await assert.rejects(service.authenticate(session, allowed), limited);
    advance(60_000);
    await service.authenticate(session, allowed);
  });

  it('limits IPs globally and more strictly for exchanges and stores only IP hashes', () => {
    const { service, advance } = fixture();
    for (let i = 0; i < 10; i++) service.checkIp('192.0.2.1', true);
    assert.throws(() => service.checkIp('192.0.2.1', true), limited);
    service.checkIp('192.0.2.2', true);
    for (let i = 0; i < 120; i++) service.checkIp('192.0.2.3', false);
    assert.throws(() => service.checkIp('192.0.2.3', false), limited);
    const state = service as unknown as { rates: Map<string, unknown> };
    assert.equal([...state.rates.keys()].some((key) => key.includes('192.0.2.')), false);
    advance(60_000);
    service.checkIp('192.0.2.1', true);
    service.checkIp('192.0.2.3', false);
  });

  it('bounds credential and rate-map memory and recovers after expiry', async () => {
    const { service, advance } = fixture();
    for (let i = 0; i < 10_000; i++) service.issue({ ...BINDING, uid: `uid-${i}` });
    assert.throws(() => service.issue(BINDING), (error: unknown) => error instanceof ListenerRemoteError && error.status === 503);
    advance(5 * 60_000);
    const { token } = service.issue(BINDING);
    await service.exchange(token, allowed);
  });
});
