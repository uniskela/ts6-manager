import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { ListenerRemoteError, ListenerRemoteService, type Binding } from './listener-remote.js';

const BINDING: Binding = { botId: 1, serverConfigId: 2, virtualServerId: 3, channelId: 4, clid: 5, uid: 'listener-uid' };
const allowed = async (): Promise<boolean> => true;
const expired = (error: unknown): boolean => error instanceof ListenerRemoteError && error.status === 401;
const limited = (retryAfter?: number) => (error: unknown): boolean => error instanceof ListenerRemoteError
  && error.status === 429 && error.code === 'rate_limited' && (retryAfter === undefined || error.retryAfter === retryAfter);

function fixture() {
  let now = 1_000;
  const service = new ListenerRemoteService(() => now);
  const state = service as unknown as { rates: Map<string, unknown>; credentialRates: Map<string, unknown> };
  return { service, state, advance: (ms: number) => { now += ms; } };
}

async function signIn(service: ListenerRemoteService, binding: Binding = BINDING) {
  return (await service.exchange(service.issue(binding).token, allowed)).session;
}

const unknownCredential = () => randomBytes(32).toString('base64url');

describe('listener remote rate limit hardening', () => {
  it('keeps no state for unknown credentials, and a flood does not lock out a live session', async () => {
    const { service, state } = fixture();
    const session = await signIn(service);
    const before = state.credentialRates.size;
    for (let i = 0; i < 12_000; i++) {
      service.checkIp(`ipv4:10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, false);
      await assert.rejects(service.authenticate(unknownCredential(), allowed), expired);
      await assert.rejects(service.exchange(unknownCredential(), allowed), expired);
      assert.throws(() => service.checkRequest(unknownCredential()), expired);
    }
    assert.equal(state.credentialRates.size, before);
    assert.equal(service.sessionRateKey(unknownCredential()), undefined);
    assert.ok(service.sessionRateKey(session)?.startsWith('listener:'));
    assert.deepEqual(await service.authenticate(session, allowed), BINDING);
    assert.ok(state.rates.size <= 10_000);
  });

  it('evicts the oldest address window when the address store is full, never refusing everyone', () => {
    const { service, state } = fixture();
    for (let i = 0; i < 120; i++) service.checkIp('ipv4:192.0.2.1', false);
    assert.throws(() => service.checkIp('ipv4:192.0.2.1', false), limited());
    for (let i = 0; i < 10_000; i++) service.checkIp(`ipv6:${i.toString(16).padStart(16, '0')}/64`, false);
    assert.equal(state.rates.size, 10_000);
    // A new address gets its own budget and, at worst, its own 429.
    for (let i = 0; i < 120; i++) service.checkIp('ipv4:198.51.100.1', false);
    assert.throws(() => service.checkIp('ipv4:198.51.100.1', false), limited());
    // The exhausted address was the oldest window, so it was evicted.
    service.checkIp('ipv4:192.0.2.1', false);
    assert.ok(state.rates.size <= 10_000);
  });

  it('does not reset request or session limits when the listener asks for a new link', async () => {
    const { service, advance } = fixture();
    let session = await signIn(service);
    for (let i = 0; i < 5; i++) service.checkRequest(session);
    for (let i = 0; i < 59; i++) await service.authenticate(session, allowed);
    session = await signIn(service);
    assert.throws(() => service.checkRequest(session), limited());
    await service.authenticate(session, allowed);
    await assert.rejects(service.authenticate(session, allowed), limited());
    // Another listener on the same bot has its own budget.
    const other = await signIn(service, { ...BINDING, clid: 6, uid: 'other-uid' });
    service.checkRequest(other);
    advance(60_000);
    service.checkRequest(session);
    await service.authenticate(session, allowed);
  });

  it('reports the seconds left in the window, rounded up and at least one', async () => {
    const { service, advance } = fixture();
    for (let i = 0; i < 10; i++) service.checkIp('ipv4:192.0.2.1', true);
    advance(20_500);
    assert.throws(() => service.checkIp('ipv4:192.0.2.1', true), limited(40));
    advance(39_400);
    assert.throws(() => service.checkIp('ipv4:192.0.2.1', true), limited(1));
    advance(100);
    service.checkIp('ipv4:192.0.2.1', true);

    const session = await signIn(service);
    for (let i = 0; i < 5; i++) service.checkRequest(session);
    advance(1_000);
    assert.throws(() => service.checkRequest(session), limited(59));
  });
});
