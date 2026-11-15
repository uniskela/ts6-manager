import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createDiscordCommandAdapter,
  resolveTs6Role,
  type DiscordCommandDeps,
  type DiscordCommandIntent,
  type DiscordCommandPolicy,
} from './adapter.js';
import { MemoryCommandRateLimit } from './rate-limit.js';

const GUILD = '111';
const VIEWER = 'u-viewer';
const ADMIN = 'u-admin';
const VIEWER_ROLE = 'r-view';
const ADMIN_ROLE = 'r-admin';
const MANAGE_GUILD = String(1n << 5n);
const ADMINISTRATOR = String(1n << 3n);

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
      async snapshot(_guildId: string) {
        return {
          connected: true,
          serverName: 'Lab TS',
          nicknames: ['alice', 'bob'],
          channels: [{ name: 'Lobby' }, { name: 'Music' }],
        };
      },
    },
    bridge: {
      async health(_guildId: string) {
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
      presence: { async snapshot(_guildId: string) { throw new Error('should not query'); } },
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

  it('isolated-live Administrator grant maps to TS6 admin; Manage Guild alone still does not', async () => {
    const adapter = createDiscordCommandAdapter(deps({
      policy: {
        viewerRoleIds: [VIEWER_ROLE],
        adminRoleIds: [ADMIN_ROLE],
        isolatedLiveAdministratorGrant: true,
      },
    }));
    const adminBit = await adapter.handle(intent({
      command: 'ts.online',
      userId: 'u-owner',
      roleIds: [],
      memberPermissions: ADMINISTRATOR,
    }));
    const manageOnly = await adapter.handle(intent({
      command: 'ts.online',
      userId: 'u-mod',
      roleIds: [],
      memberPermissions: MANAGE_GUILD,
    }));
    assert.equal(adminBit.ok, true);
    assert.equal(manageOnly.code, 'unauthorized');
  });

  it('Administrator bit does not grant TS6 roles when isolated-live grant is off (production default)', async () => {
    const policy: DiscordCommandPolicy = {
      viewerRoleIds: [VIEWER_ROLE],
      adminRoleIds: [ADMIN_ROLE],
    };
    assert.equal(
      resolveTs6Role(intent({
        command: 'ts.online',
        userId: 'u-owner',
        roleIds: [],
        memberPermissions: ADMINISTRATOR,
      }), policy),
      null,
    );
    const adapter = createDiscordCommandAdapter(deps({ policy }));
    const denied = await adapter.handle(intent({
      command: 'queue',
      userId: 'u-owner',
      roleIds: [],
      memberPermissions: ADMINISTRATOR,
    }));
    assert.equal(denied.code, 'unauthorized');
  });

  it('role ID mapping still wins over Administrator when isolated-live grant is on', () => {
    const policy: DiscordCommandPolicy = {
      viewerRoleIds: [VIEWER_ROLE],
      adminRoleIds: [ADMIN_ROLE],
      isolatedLiveAdministratorGrant: true,
    };
    assert.equal(
      resolveTs6Role(intent({
        command: 'ts.online',
        userId: VIEWER,
        roleIds: [VIEWER_ROLE],
        memberPermissions: ADMINISTRATOR,
      }), policy),
      'viewer',
    );
    assert.equal(
      resolveTs6Role(intent({
        command: 'ts.online',
        userId: ADMIN,
        roleIds: [ADMIN_ROLE],
        memberPermissions: '0',
      }), policy),
      'admin',
    );
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
      presence: { async snapshot(_guildId: string) { queried = true; return null; } },
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
      presence: { async snapshot(_guildId: string) { return null; } },
      bridge: { async health(_guildId: string) { throw new Error('worker down'); } },
    }));
    const online = await adapter.handle(intent({ command: 'ts.online', userId: VIEWER }));
    const bridge = await adapter.handle(intent({ command: 'ts.bridge', userId: ADMIN }));
    assert.equal(online.code, 'unavailable');
    assert.equal(online.ephemeral, true);
    assert.equal(bridge.code, 'unavailable');
    assert.equal(bridge.ack, 'immediate');
  });

  it('unknown commands stay Unknown command when presence is null; presence cmds still fail closed', async () => {
    let presenceCalls = 0;
    let bridgeCalls = 0;
    let musicCalls = 0;
    const adapter = createDiscordCommandAdapter(deps({
      presence: {
        async snapshot(_guildId: string) {
          presenceCalls += 1;
          return null;
        },
      },
      bridge: {
        async health(_guildId: string) {
          bridgeCalls += 1;
          return null;
        },
      },
      music: {
        async execute() {
          musicCalls += 1;
          return { ok: true, ephemeral: true, content: 'played', ack: 'immediate' };
        },
      },
    }));

    const unknown = await adapter.handle(intent({ command: 'notacommand', userId: VIEWER }));
    assert.equal(unknown.code, 'unauthorized');
    assert.match(unknown.content, /Unknown command/i);
    assert.equal(presenceCalls, 0, 'unknown must not query presence');

    const online = await adapter.handle(intent({ command: 'ts.online', userId: VIEWER }));
    assert.equal(online.code, 'unavailable');
    assert.match(online.content, /TeamSpeak is unavailable/i);
    assert.equal(presenceCalls, 1);

    const status = await adapter.handle(intent({ command: 'ts.status', userId: ADMIN }));
    assert.equal(status.code, 'unavailable');
    assert.equal(presenceCalls, 2);

    const bridge = await adapter.handle(intent({ command: 'ts.bridge', userId: ADMIN }));
    assert.equal(bridge.code, 'unavailable');
    assert.match(bridge.content, /Bridge status is unavailable/i);
    assert.equal(bridgeCalls, 1);
    assert.equal(presenceCalls, 2, 'bridge must not query presence');

    const help = await adapter.handle(intent({ command: 'ts.help', userId: VIEWER }));
    assert.equal(help.ok, true);

    // Auth still first: unpaired / no role never reach unknown/presence.
    const unpaired = await adapter.handle(intent({
      command: 'notacommand',
      userId: VIEWER,
      guildId: '999',
    }));
    assert.equal(unpaired.code, 'unpaired');
    const noRole = await adapter.handle(intent({
      command: 'notacommand',
      userId: 'u-none',
      roleIds: [],
      memberPermissions: '0',
    }));
    assert.equal(noRole.code, 'unauthorized');
    assert.doesNotMatch(noRole.content, /Unknown command/i);

    assert.equal(musicCalls, 0, 'no playback side effects');
  });

  it('reserves Phase 2B music commands without mutating playback', async () => {
    let presenceCalls = 0;
    const adapter = createDiscordCommandAdapter(deps({
      presence: { async snapshot(_guildId: string) { presenceCalls += 1; return null; } },
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
