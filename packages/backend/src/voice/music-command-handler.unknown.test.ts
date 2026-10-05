import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { MusicCommandHandler } from './music-command-handler.js';
import { PlayQueue } from './playlist/queue.js';
import { suggestBuiltinCommand } from './chat-commands.js';
import { formatUnknownCommandMessage } from './ts6-chat-format.js';
import { resetChatReplyCooldownsForTests } from './commands/dedupe.js';

beforeEach(() => resetChatReplyCooldownsForTests());

function fixture(customCommands: Record<string, { response: string; enabled: boolean }> = {}) {
  const replies: string[] = [];
  const prisma = {
    musicBot: { findUnique: async () => ({ serverConfigId: 9 }) },
    chatCommand: {
      findUnique: async ({ where }: any) => {
        const c = customCommands[where.serverConfigId_name.name];
        return c ? { name: where.serverConfigId_name.name, ...c } : null;
      },
    },
  } as any;
  const handler = new MusicCommandHandler(prisma, {} as any) as any;
  handler.reply = (_bot: unknown, _id: number, message: string) => replies.push(message);
  const bot = {
    currentConfig: { id: 1, serverConfigId: 9 }, ts3ClientId: 42, queue: new PlayQueue(),
    status: 'connected', nowPlaying: null, getCurrentChannelId: () => 5,
  };
  const command = (msg: string) => handler.onTextMessage(1, bot, { invokerid: '2', msg });
  return { handler, command, replies };
}

test('unknown !command replies with a pointer to !help and !commands', async () => {
  const f = fixture();
  await f.command('!banana');
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0], /Unknown command \*\*!banana\*\*/);
  assert.match(f.replies[0], /!help/);
  assert.match(f.replies[0], /!commands/);
});

test('mistyped built-in suggests the closest command', async () => {
  const f = fixture();
  await f.command('!plya some song');
  assert.match(f.replies[0], /Did you mean \*\*!play\*\*\?/);
});

test('custom commands and flow commands are not reported as unknown', async () => {
  const f = fixture({ rules: { response: 'Be nice', enabled: true }, off: { response: 'x', enabled: false } });
  f.handler.setFlowCommandLookup((cfg: number, sid: number, name: string) => cfg === 9 && sid === 1 && name === 'roll');
  await f.command('!rules');
  await f.command('!roll 20');
  assert.deepEqual(f.replies, ['Be nice']);
  await f.command('!off');
  assert.match(f.replies.at(-1)!, /Unknown command \*\*!off\*\*/);
});

test('bare or punctuation-only prefixes are ignored', async () => {
  const f = fixture();
  await f.command('!');
  await f.command('!!!');
  await f.command('! hello');
  assert.deepEqual(f.replies, []);
});

test('suggestBuiltinCommand only suggests close matches', () => {
  assert.equal(suggestBuiltinCommand('plya'), 'play');
  assert.equal(suggestBuiltinCommand('SKPI'), 'skip');
  assert.equal(suggestBuiltinCommand('banana'), null);
  assert.equal(suggestBuiltinCommand('x'), null);
});

test('formatUnknownCommandMessage truncates very long names', () => {
  const msg = formatUnknownCommandMessage('a'.repeat(80), null);
  assert.ok(msg.includes(`!${'a'.repeat(32)}…`));
  assert.ok(!msg.includes('Did you mean'));
});
