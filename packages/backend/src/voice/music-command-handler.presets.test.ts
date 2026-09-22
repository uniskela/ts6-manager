import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  MusicCommandHandler,
  resetChatReplyCooldownsForTests,
} from './music-command-handler.js';

afterEach(() => {
  resetChatReplyCooldownsForTests();
});

function makeBot(id: number, channelId = 5) {
  const replies: string[] = [];
  const bot = {
    currentConfig: { id, serverConfigId: 9 },
    ts3ClientId: 100 + id,
    status: 'connected',
    getCurrentChannelId: () => channelId,
    sendChannelMessage: (msg: string) => {
      replies.push(msg);
    },
  };
  return { bot, replies };
}

function makeHandler(customs: Array<{ name: string; response: string; enabled: boolean; description?: string | null }>) {
  const prisma = {
    musicBot: {
      findUnique: async ({ where }: { where: { id: number } }) => ({
        id: where.id,
        serverConfigId: 9,
      }),
    },
    chatCommand: {
      findMany: async ({ where }: any) => {
        return customs
          .filter((c) => (where.enabled === undefined ? true : c.enabled === where.enabled))
          .map((c) => ({
            name: c.name,
            description: c.description ?? null,
            response: c.response,
            enabled: c.enabled,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      findUnique: async ({ where }: any) => {
        const name = where.serverConfigId_name?.name;
        const hit = customs.find((c) => c.name === name);
        return hit
          ? {
              name: hit.name,
              response: hit.response,
              enabled: hit.enabled,
              description: hit.description ?? null,
            }
          : null;
      },
    },
  } as any;

  const handler = new MusicCommandHandler(prisma, {} as any) as any;
  return handler;
}

test('custom !rules routes to enabled server-scoped response', async () => {
  const handler = makeHandler([
    { name: 'rules', response: '## Be nice', enabled: true, description: 'Rules' },
  ]);
  const { bot, replies } = makeBot(1);
  await handler.onTextMessage(1, bot, { invokerid: '2', msg: '!rules' }, 5);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /Be nice/);
});

test('disabled custom commands do not reply', async () => {
  const handler = makeHandler([
    { name: 'rules', response: '## Be nice', enabled: false },
  ]);
  const { bot, replies } = makeBot(1);
  await handler.onTextMessage(1, bot, { invokerid: '2', msg: '!rules' }, 5);
  assert.equal(replies.length, 0);
});

test('!commands lists only enabled customs', async () => {
  const handler = makeHandler([
    { name: 'rules', response: 'r', enabled: true, description: 'Server rules' },
    { name: 'links', response: 'l', enabled: false, description: 'Links' },
  ]);
  const { bot, replies } = makeBot(1);
  await handler.onTextMessage(1, bot, { invokerid: '2', msg: '!commands' }, 5);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /!rules/);
  assert.doesNotMatch(replies[0], /!links/);
});

test('multi-bot same channel dedupes !help to a single reply', async () => {
  const handler = makeHandler([]);
  const a = makeBot(1, 5);
  const b = makeBot(2, 5);
  await handler.onTextMessage(1, a.bot, { invokerid: '7', msg: '!help' }, 5);
  await handler.onTextMessage(2, b.bot, { invokerid: '7', msg: '!help' }, 5);
  assert.equal(a.replies.length, 1);
  assert.equal(b.replies.length, 0);
  assert.match(a.replies[0], /Music bot commands/);
});

test('multi-bot same channel dedupes custom preset replies', async () => {
  const handler = makeHandler([
    { name: 'links', response: '## Links\n- site', enabled: true },
  ]);
  const a = makeBot(1, 5);
  const b = makeBot(2, 5);
  await handler.onTextMessage(1, a.bot, { invokerid: '7', msg: '!links' }, 5);
  await handler.onTextMessage(2, b.bot, { invokerid: '7', msg: '!links' }, 5);
  assert.equal(a.replies.length, 1);
  assert.equal(b.replies.length, 0);
});

test('cross-channel listener picks one bot for custom presets', async () => {
  const handler = makeHandler([
    { name: 'info', response: 'about us', enabled: true },
  ]) as any;

  handler.botChannelConfig.set(1, {
    serverConfigId: 9,
    virtualServerId: 1,
    defaultChannel: '5',
    commandChannelIds: ['5', '12'],
  });
  handler.botChannelConfig.set(2, {
    serverConfigId: 9,
    virtualServerId: 1,
    defaultChannel: '8',
    commandChannelIds: ['12'],
  });
  handler.channelToBots.set('9:1:12', new Set([1, 2]));

  const crossReplies: string[] = [];
  const bots = new Map<number, any>();
  for (const id of [1, 2]) {
    const { bot } = makeBot(id, id === 1 ? 5 : 8);
    bots.set(id, bot);
  }

  handler.voiceBotManager = {
    getBot: (id: number) => bots.get(id),
  };
  handler.eventBridge = {
    sendChannelText: async (_c: number, _s: number, _cid: number, msg: string) => {
      crossReplies.push(msg);
      return true;
    },
  };

  await handler.onCrossChannelTextMessage(9, 1, 12, {
    invokerid: '3',
    msg: '!info',
  });
  // Allow the fire-and-forget sendChannelText microtask to settle.
  await Promise.resolve();

  assert.equal(crossReplies.length, 1);
  assert.match(crossReplies[0], /about us/);
});
