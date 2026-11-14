import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDiscordCommandAdapter } from './adapter.js';
import { parseInteractionEnvelope, planAcknowledgement } from './interaction.js';
import { MUSIC_COMMANDS } from './music.js';
import { createMusicCommandService } from './music-service.js';
import { MemoryCommandIdempotency } from './idempotency.js';
import { defaultMediaCommandPermissions } from '../voice/media-command-permissions.js';
import { PlayQueue } from '../voice/playlist/queue.js';
import {
  ackModeForHandlerCommand,
  getSupportedHandlerCommands,
  getSupportedSlashCommands,
  interactionDataForCommand,
  toDiscordCommandBody,
  validateSlashCommandRegistry,
} from './slash-commands.js';

const GUILD = '111000000000000001';
const VIEWER = 'r-view';
const ADMIN = 'r-admin';

function fakeBot() {
  return {
    currentConfig: { id: 10, serverConfigId: 1, serverPort: 10011, volume: 40, name: 'Bot' },
    status: 'connected',
    nowPlaying: null,
    isStreaming: false,
    stopGeneration: 0,
    playbackProgress: { position: 0, duration: 0 },
    queue: new PlayQueue(),
    assertMusicCanStart: () => {},
    pause() {},
    resume() {},
    stopAudio() {},
    applyVolume: async (volume: number) => { (fakeBot as any).volume = volume; },
    play: async () => {},
    playStream: async () => {},
  } as any;
}

function adapter() {
  const bot = fakeBot();
  const music = createMusicCommandService({
    getBot: (id) => (id === 10 ? bot : null),
    virtualServerIdForBot: () => 1,
    loadMediaPermissions: async () => defaultMediaCommandPermissions(),
    idempotency: new MemoryCommandIdempotency(),
  });
  return createDiscordCommandAdapter({
    bindings: {
      get: async (guildId) => guildId === GUILD
        ? { instanceId: 'local', revoked: false, botId: 10, serverConfigId: 1 }
        : null,
    },
    policy: { viewerRoleIds: [VIEWER], adminRoleIds: [ADMIN] },
    presence: {
      async snapshot(_guildId: string) {
        return { connected: true, serverName: 'TS', nicknames: ['A'], channels: [{ name: 'Lobby' }] };
      },
    },
    bridge: { async health(_guildId: string) { return { daveReady: true, electedSlot: '0', generation: 1 }; } },
    audit: () => {},
    music,
  });
}

function interactionBody(command: string, opts?: Parameters<typeof interactionDataForCommand>[1]) {
  return JSON.stringify({
    type: 2,
    id: 'ix-1',
    application_id: '999000000000000001',
    token: 'tok',
    guild_id: GUILD,
    member: { user: { id: 'u1' }, roles: [VIEWER, ADMIN], permissions: '0' },
    data: interactionDataForCommand(command, opts),
  });
}

describe('Discord slash-command definitions (Phase 2C step 3B.2)', () => {
  it('registry validates and covers every music command', () => {
    const errors = validateSlashCommandRegistry();
    assert.deepEqual(errors, []);
    const names = new Set(getSupportedSlashCommands().map((c) => c.name));
    for (const music of MUSIC_COMMANDS) assert.ok(names.has(music), music);
  });

  it('Discord bodies stay within schema limits; omit deprecated/global-only fields', () => {
    for (const cmd of getSupportedSlashCommands()) {
      const body = toDiscordCommandBody(cmd);
      // Guild scope is the guilds/{id}/commands endpoint — omit dm_permission/contexts.
      assert.ok(!('dm_permission' in body));
      assert.ok(!('contexts' in body));
      assert.ok(!('integration_types' in body));
      assert.equal(body.type, 1);
      assert.ok(String(body.name).length <= 32);
      assert.ok(String(body.description).length <= 100);
      assert.ok(!('handlerCommands' in body));
      assert.ok(!('ts6Permission' in body));
    }
  });

  it('every registered handler routes through the existing adapter', async () => {
    const handle = adapter().handle;
    for (const command of getSupportedHandlerCommands()) {
      const opts = command === 'play'
        ? { options: { query: 'https://example.invalid/a.mp3' } }
        : command === 'playlist'
          ? { subcommand: 'list' }
          : command === 'radio'
            ? { subcommand: 'list' }
            : command === 'volume'
              ? { options: { level: '40' } }
              : undefined;
      const envelope = parseInteractionEnvelope(interactionBody(command, opts));
      assert.ok(envelope && !('ping' in envelope));
      assert.equal(envelope!.intent.command, command);
      assert.equal(typeof envelope!.intent.guildId, 'string');
      const result = await handle(envelope!.intent);
      // Bound guild + roles → not unpaired/unauthorized for known commands.
      assert.notEqual(result.code, 'unauthorized', command);
      assert.notEqual(result.code, 'unpaired', command);
      // Full registry must be wired — never silent not_implemented with deps present.
      assert.notEqual(result.code, 'not_implemented', command);
      // play may fail unavailable without network — still routed.
      if (command === 'ts.help') assert.equal(result.ok, true);
      if (command === 'ts.status' || command === 'ts.online' || command === 'ts.channels') {
        assert.equal(result.ok, true, command);
      }
      if (command === 'ts.bridge') assert.equal(result.ok, true, command);
    }
  });

  it('fails if a slash command is registered without a backend handler mapping', () => {
    const cmds = getSupportedSlashCommands().map((c) => ({
      ...c,
      handlerCommands: c.name === 'play' ? [] as const : c.handlerCommands,
    }));
    const errors = validateSlashCommandRegistry(cmds as any);
    assert.ok(errors.some((e) => /play.*handler/i.test(e) || /missing handler/i.test(e)));
  });

  it('ack classification matches deferred music vs immediate controls', () => {
    assert.equal(ackModeForHandlerCommand('play'), 'deferred');
    assert.equal(ackModeForHandlerCommand('playlist'), 'deferred');
    assert.equal(ackModeForHandlerCommand('radio'), 'deferred');
    assert.equal(ackModeForHandlerCommand('queue'), 'immediate');
    assert.equal(ackModeForHandlerCommand('ts.help'), 'immediate');
    assert.equal(planAcknowledgement('play'), 'deferred');
  });

  it('unknown command, missing args, revoked guild, and snowflake string safety', async () => {
    const handle = adapter().handle;
    const unknown = parseInteractionEnvelope(JSON.stringify({
      type: 2,
      id: 'ix',
      application_id: '1',
      token: 't',
      guild_id: GUILD,
      member: { user: { id: 'u1' }, roles: [VIEWER], permissions: '0' },
      data: { name: 'notacommand' },
    }));
    assert.ok(unknown && !('ping' in unknown));
    const unknownResult = await handle(unknown!.intent);
    assert.equal(unknownResult.code, 'unauthorized');

    const playMissing = parseInteractionEnvelope(interactionBody('play', { options: {} }));
    // query omitted → play still parses; music service returns usage unavailable.
    assert.ok(playMissing && !('ping' in playMissing));
    assert.equal(playMissing.intent.command, 'play');
    const missing = await handle(playMissing.intent);
    assert.equal(missing.ok, false);
    assert.match(missing.content, /usage|play/i);

    const revokedAdapter = createDiscordCommandAdapter({
      bindings: {
        get: async () => ({ instanceId: 'local', revoked: true, botId: 10, serverConfigId: 1 }),
      },
      policy: { viewerRoleIds: [VIEWER], adminRoleIds: [ADMIN] },
      presence: { async snapshot(_guildId: string) { return null; } },
      bridge: { async health(_guildId: string) { return null; } },
      audit: () => {},
    });
    const revoked = await revokedAdapter.handle({
      guildId: GUILD,
      userId: 'u1',
      roleIds: [VIEWER],
      memberPermissions: '0',
      command: 'queue',
    });
    assert.equal(revoked.code, 'unpaired');

    const envelope = parseInteractionEnvelope(interactionBody('queue'));
    assert.equal(typeof envelope!.intent.guildId, 'string');
    assert.equal(envelope!.intent.guildId, GUILD);
  });

  it('playlist/radio subcommands and optional volume parse into intent.args', () => {
    const playlist = parseInteractionEnvelope(interactionBody('playlist', {
      subcommand: 'add',
      options: { name: 'Chill', url: 'https://example.invalid/a.mp3' },
    }));
    assert.ok(playlist && !('ping' in playlist));
    assert.equal(playlist!.intent.command, 'playlist');
    assert.equal(playlist!.intent.args?.subcommand, 'add');
    assert.equal(playlist!.intent.args?.name, 'Chill');
    assert.equal(playlist!.intent.args?.url, 'https://example.invalid/a.mp3');

    const radio = parseInteractionEnvelope(interactionBody('radio', {
      subcommand: 'play',
      options: { station: 'Soma' },
    }));
    assert.equal(radio && !('ping' in radio) && radio.intent.args?.station, 'Soma');
  });

  it('ts.status requires admin role; viewer gets unauthorized', async () => {
    const handle = adapter().handle;
    const body = interactionBody('ts.status');
    const env = parseInteractionEnvelope(body);
    assert.ok(env && !('ping' in env));
    // Override roles to viewer-only
    const result = await handle({ ...env!.intent, roleIds: [VIEWER] });
    assert.equal(result.code, 'unauthorized');
  });
});
