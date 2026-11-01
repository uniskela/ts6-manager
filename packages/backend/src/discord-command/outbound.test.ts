import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { createDiscordCommandAdapter, type DiscordCommandDeps } from './adapter.js';
import { handleSignedInteraction, planAcknowledgement } from './interaction.js';
import { createOutboundCommandSession } from './outbound.js';
import { MemoryReplayGuard, signInvokeHmac } from './security.js';

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
    sign(timestamp: string, body: string) {
      return sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString('hex');
    },
  };
}

function adapterDeps(): DiscordCommandDeps {
  return {
    bindings: { get: (guildId) => guildId === '111' ? { instanceId: 'inst-1', revoked: false } : null },
    policy: { viewerRoleIds: ['r-view'], adminRoleIds: ['r-admin'] },
    presence: {
      async snapshot() {
        return { connected: true, serverName: 'Lab TS', nicknames: ['alice'], channels: [{ name: 'Lobby' }] };
      },
    },
    bridge: { async health() { return { daveReady: true, electedSlot: 'slot-0', generation: 1 }; } },
    audit: () => {},
  };
}

function helpIntent() {
  return {
    guildId: '111',
    userId: 'u-view',
    roleIds: ['r-view'],
    memberPermissions: '0',
    command: 'ts.help',
  };
}

describe('outbound hosted session (no inbound public API)', () => {
  it('delivers a signed intent from the hub to the adapter', async () => {
    const adapter = createDiscordCommandAdapter(adapterDeps());
    const session = createOutboundCommandSession({
      instanceId: 'inst-1',
      secret: 'instance-secret',
      adapter,
      replay: new MemoryReplayGuard(),
    });
    const timestamp = '1700000000';
    const nonce = 'out-1';
    const body = JSON.stringify(helpIntent());
    const result = await session.receive({
      timestamp,
      nonce,
      body,
      signatureHex: signInvokeHmac({ secret: 'instance-secret', timestamp, nonce, body }),
      nowMs: 1_700_000_000_000,
    });
    assert.equal(result.ok, true);
    assert.match(result.content, /\/ts help/);
  });

  it('rejects a replayed outbound envelope before the adapter runs', async () => {
    let handles = 0;
    const adapter = {
      async handle() {
        handles += 1;
        return { ok: true, ephemeral: false, content: 'x', ack: 'immediate' as const };
      },
    };
    const session = createOutboundCommandSession({
      instanceId: 'inst-1',
      secret: 'instance-secret',
      adapter,
      replay: new MemoryReplayGuard(),
    });
    const timestamp = '1700000000';
    const nonce = 'out-1';
    const body = JSON.stringify(helpIntent());
    const envelope = {
      timestamp,
      nonce,
      body,
      signatureHex: signInvokeHmac({ secret: 'instance-secret', timestamp, nonce, body }),
      nowMs: 1_700_000_000_000,
    };
    await session.receive(envelope);
    const replayed = await session.receive({ ...envelope, nowMs: 1_700_000_000_100 });
    assert.equal(handles, 1);
    assert.equal(replayed.code, 'replay');
  });

  it('drops commands after revocation', async () => {
    const adapter = createDiscordCommandAdapter(adapterDeps());
    const session = createOutboundCommandSession({
      instanceId: 'inst-1',
      secret: 'instance-secret',
      adapter,
      replay: new MemoryReplayGuard(),
    });
    session.revoke();
    const timestamp = '1700000000';
    const nonce = 'out-2';
    const body = JSON.stringify(helpIntent());
    const result = await session.receive({
      timestamp,
      nonce,
      body,
      signatureHex: signInvokeHmac({ secret: 'instance-secret', timestamp, nonce, body }),
      nowMs: 1_700_000_000_000,
    });
    assert.equal(result.code, 'unpaired');
  });
});

describe('self-hosted signed interaction transport', () => {
  it('accepts a mocked Discord interaction fixture', async () => {
    const k = keys();
    const adapter = createDiscordCommandAdapter(adapterDeps());
    const timestamp = '1700000000';
    const body = JSON.stringify({
      type: 2,
      guild_id: '111',
      member: { user: { id: 'u-view' }, roles: ['r-view'], permissions: '0' },
      data: { name: 'ts', options: [{ name: 'help', type: 1 }] },
    });
    const result = await handleSignedInteraction({
      publicKeyHex: k.publicKeyHex,
      timestamp,
      body,
      signatureHex: k.sign(timestamp, body),
      adapter,
      nowMs: 1_700_000_000_000,
    });
    assert.equal(result.ok, true);
    assert.match(result.content, /\/ts online/);
  });

  it('rejects an invalid Discord signature without calling the adapter', async () => {
    const k = keys();
    let handles = 0;
    const timestamp = '1700000000';
    const body = JSON.stringify({ type: 2, guild_id: '111', data: { name: 'ts' } });
    const result = await handleSignedInteraction({
      publicKeyHex: k.publicKeyHex,
      timestamp,
      body,
      signatureHex: k.sign(timestamp, '{"type":1}'),
      adapter: { async handle() { handles += 1; return { ok: true, ephemeral: false, content: '', ack: 'immediate' }; } },
      nowMs: 1_700_000_000_000,
    });
    assert.equal(result.code, 'invalid_signature');
    assert.equal(handles, 0);
  });

  it('answers Discord PING without a pairing', async () => {
    const k = keys();
    const timestamp = '1700000000';
    const body = JSON.stringify({ type: 1 });
    const result = await handleSignedInteraction({
      publicKeyHex: k.publicKeyHex,
      timestamp,
      body,
      signatureHex: k.sign(timestamp, body),
      adapter: { async handle() { throw new Error('ping must not dispatch'); } },
      nowMs: 1_700_000_000_000,
    });
    assert.equal(result.ack, 'pong');
    assert.equal(result.ok, true);
  });
});

describe('acknowledgements', () => {
  it('acks read-only commands immediately and defers Phase 2 music', () => {
    assert.equal(planAcknowledgement('ts.help'), 'immediate');
    assert.equal(planAcknowledgement('ts.online'), 'immediate');
    assert.equal(planAcknowledgement('play'), 'deferred');
  });
});
