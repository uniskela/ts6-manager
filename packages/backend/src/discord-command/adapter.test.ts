import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDiscordCommandAdapter, type DiscordCommandDeps, type DiscordCommandIntent } from './adapter.js';
import { MemoryCommandRateLimit } from './rate-limit.js';

const GUILD = '111';
const VIEWER = 'u-viewer';
const ADMIN = 'u-admin';
const VIEWER_ROLE = 'r-view';
const ADMIN_ROLE = 'r-admin';
const MANAGE_GUILD = String(1n << 5n);

function intent(partial: Partial<DiscordCommandIntent> & Pick<DiscordCommandIntent, 'command' | 'userId'>): DiscordCommandIntent {
  const admin = partial.userId === ADMIN;
  return {
    guildId: GUILD,
    roleIds: admin ? [ADMIN_ROLE] : [VIEWER_ROLE],
    memberPermissions: admin ? MANAGE_GUILD : '0',
    ...partial,
  };
}

function deps(overrides: Partial<DiscordCommandDeps> = {}): DiscordCommandDeps {
  const audits: DiscordCommandDeps['audit'] extends (e: infer E) => void ? E[] : never[] = [] as any;
  const base: DiscordCommandDeps = {
    bindings: {
      get(guildId) {
        return guildId === GUILD ? { instanceId: 'inst-1', revoked: false } : null;
      },
    },
    policy: { viewerRoleIds: [VIEWER_ROLE], adminRoleIds: [ADMIN_ROLE] },
    presence: {
      async snapshot() {
        return {
          connected: true,
          serverName: 'Lab TS',
          nicknames: ['alice', 'bob'],
          channels: [{ name: 'Lobby' }, { name: 'Music' }],
        };
      },
    },
    bridge: {
      async health() {
        return { daveReady: true, electedSlot: 'slot-0', generation: 4, t2dForwarded: 100 };
      },
    },
    audit: (event) => { audits.push(event); },
  };
  return Object.assign(base, overrides, { _audits: audits } as any);
}

describe('read-only Discord command adapter', () => {
  it('answers /ts help without TeamSpeak', async () => {
    const adapter = createDiscordCommandAdapter(deps({
      presence: { async snapshot() { throw new Error('should not query'); } },
    }));
    const result = await adapter.handle(intent({ command: 'ts.help', userId: VIEWER }));
    assert.equal(result.ok, true);
    assert.match(result.content, /\/ts status/);
    assert.equal(result.ack, 'immediate');
  });

  it('returns online nicknames and channel names from existing presence', async () => {
    const adapter = createDiscordCommandAdapter(deps());
    const online = await adapter.handle(intent({ command: 'ts.online', userId: VIEWER }));
    const channels = await adapter.handle(intent({ command: 'ts.channels', userId: VIEWER }));
    assert.equal(online.ok, true);
    assert.equal(online.ephemeral, true);
    assert.match(online.content, /alice/);
    assert.doesNotMatch(online.content, /password|token|enc:|clid|uid/i);
    assert.equal(channels.ok, true);
    assert.equal(channels.ephemeral, true);
    assert.match(channels.content, /Lobby/);
  });

  it('does not treat Discord Manage Guild as TS6 admin', async () => {
    const adapter = createDiscordCommandAdapter(deps());
    const unmanaged = await adapter.handle(intent({
      command: 'ts.status',
      userId: 'u-owner',
      roleIds: [],
      memberPermissions: MANAGE_GUILD,
    }));
    const mappedViewer = await adapter.handle(intent({
      command: 'ts.status',
      userId: VIEWER,
      roleIds: [VIEWER_ROLE],
      memberPermissions: MANAGE_GUILD,
    }));
    assert.equal(unmanaged.code, 'unauthorized');
    assert.equal(mappedViewer.code, 'unauthorized');
  });

  it('keeps /ts status and /ts bridge ephemeral and secret-free', async () => {
    const adapter = createDiscordCommandAdapter(deps());
    const status = await adapter.handle(intent({ command: 'ts.status', userId: ADMIN }));
    const bridge = await adapter.handle(intent({ command: 'ts.bridge', userId: ADMIN }));
    assert.equal(status.ok, true);
    assert.equal(status.ephemeral, true);
    assert.match(status.content, /Lab TS/);
    assert.equal(bridge.ok, true);
    assert.equal(bridge.ephemeral, true);
    assert.match(bridge.content, /daveReady=true/);
    assert.doesNotMatch(bridge.content, /token|secret|enc:/i);
  });

  it('denies an unpaired guild without querying TeamSpeak', async () => {
    let queried = false;
    const adapter = createDiscordCommandAdapter(deps({
      presence: { async snapshot() { queried = true; return null; } },
    }));
    const result = await adapter.handle(intent({ command: 'ts.online', userId: VIEWER, guildId: '999' }));
    assert.deepEqual(
      { ok: result.ok, code: result.code, ephemeral: result.ephemeral },
      { ok: false, code: 'unpaired', ephemeral: true },
    );
    assert.equal(queried, false);
  });

  it('denies a revoked binding as unpaired', async () => {
    const adapter = createDiscordCommandAdapter(deps({
      bindings: { get: () => ({ instanceId: 'inst-1', revoked: true }) },
    }));
    const result = await adapter.handle(intent({ command: 'ts.online', userId: VIEWER }));
    assert.equal(result.code, 'unpaired');
  });

  it('denies viewer /ts status and /ts bridge', async () => {
    const adapter = createDiscordCommandAdapter(deps());
    const status = await adapter.handle(intent({ command: 'ts.status', userId: VIEWER }));
    const bridge = await adapter.handle(intent({ command: 'ts.bridge', userId: VIEWER }));
    assert.equal(status.code, 'unauthorized');
    assert.equal(status.ephemeral, true);
    assert.equal(bridge.code, 'unauthorized');
  });

  it('treats TeamSpeak or bridge failure as unavailable', async () => {
    const adapter = createDiscordCommandAdapter(deps({
      presence: { async snapshot() { return null; } },
      bridge: { async health() { throw new Error('worker down'); } },
    }));
    const online = await adapter.handle(intent({ command: 'ts.online', userId: VIEWER }));
    const bridge = await adapter.handle(intent({ command: 'ts.bridge', userId: ADMIN }));
    assert.equal(online.code, 'unavailable');
    assert.equal(online.ephemeral, true);
    assert.equal(bridge.code, 'unavailable');
    assert.equal(bridge.ack, 'immediate');
  });

  it('reserves Phase 2B music commands without mutating playback', async () => {
    let presenceCalls = 0;
    const adapter = createDiscordCommandAdapter(deps({
      presence: { async snapshot() { presenceCalls += 1; return null; } },
    }));
    for (const command of ['pause', 'resume', 'skip', 'stop', 'playlist', 'radio', 'volume']) {
      const result = await adapter.handle(intent({ command, userId: ADMIN }));
      assert.equal(result.code, 'not_implemented', command);
      assert.equal(result.ok, false);
    }
    assert.equal(presenceCalls, 0);
  });

  it('writes an audit row for every handled command', async () => {
    const d = deps();
    const adapter = createDiscordCommandAdapter(d);
    await adapter.handle(intent({ command: 'ts.help', userId: VIEWER }));
    const events = (d as any)._audits;
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      guildId: GUILD, userId: VIEWER, command: 'ts.help', result: 'ok',
    });
  });

  it('rate-limits a user in a guild', async () => {
    const adapter = createDiscordCommandAdapter({
      ...deps(),
      rateLimit: new MemoryCommandRateLimit(1, 60_000),
      nowMs: () => 1_700_000_000_000,
    });
    const first = await adapter.handle(intent({ command: 'ts.help', userId: VIEWER }));
    const second = await adapter.handle(intent({ command: 'ts.help', userId: VIEWER }));
    assert.equal(first.ok, true);
    assert.equal(second.code, 'rate_limited');
    assert.equal(second.ephemeral, true);
  });
});
