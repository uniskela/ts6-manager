import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BUILTIN_CHAT_COMMANDS } from '../../../common/src/constants/chat-commands.ts';
import { BOT_TEMPLATES, templateConfigError } from '../../src/data/bot-templates.ts';

function template(id: string) {
  const found = BOT_TEMPLATES.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

function types(id: string, config: Record<string, string>) {
  return template(id).flowDataFactory(config).nodes.map((node) => node.type);
}

describe('flow template configuration', () => {
  it('requires a parent channel and staff group for support tickets', () => {
    const support = template('support-ticket');
    assert.match(templateConfigError(support, {}) ?? '', /Parent Channel ID is required/);
    assert.match(templateConfigError(support, { parentChannelId: '4', staffGroupId: '' }) ?? '', /Staff Group ID is required/);
    assert.match(templateConfigError(support, { parentChannelId: '0', staffGroupId: '6' }) ?? '', /numeric id/);
    assert.equal(templateConfigError(support, { parentChannelId: '19', staffGroupId: '6' }), null);
  });

  it('accepts the reminder template with no admin fields', () => {
    assert.equal(templateConfigError(template('timed-reminder'), {}), null);
  });

  it('requires a channel id only when an announcement targets one channel', () => {
    const announcement = template('scheduled-announcement');
    assert.match(templateConfigError(announcement, { message: '', cron: '0 9 * * *', audience: 'server' }) ?? '', /Message is required/);
    assert.match(templateConfigError(announcement, {
      message: 'Hi {{time.date}}',
      cron: '* * * * *',
      audience: 'server',
    }) ?? '', /schedule/);
    assert.match(templateConfigError(announcement, {
      message: 'Hi {{time.date}}',
      cron: '0 9 * * *',
      audience: 'channel',
      channelId: '',
    }) ?? '', /Channel ID/);
    assert.equal(templateConfigError(announcement, {
      message: 'Hi {{time.date}}',
      cron: '0 9 * * *',
      audience: 'server',
    }), null);
    assert.equal(templateConfigError(announcement, {
      message: 'Hi {{time.date}}',
      cron: '0 9 * * *',
      audience: 'channel',
      channelId: '12',
    }), null);
  });
});

describe('flow template graphs', () => {
  it('gives every connection a unique id so editing one leaves the others intact', () => {
    for (const entry of BOT_TEMPLATES) {
      const defaults = Object.fromEntries(entry.configFields.map((field) => [field.key, field.defaultValue ?? '1']));
      const { edges } = entry.flowDataFactory(defaults);
      assert.equal(new Set(edges.map((edge) => edge.id)).size, edges.length, entry.id);
    }
  });
  it('builds a support ticket from existing channel, move, poke, and cleanup actions', () => {
    const flow = template('support-ticket').flowDataFactory({ parentChannelId: '19', staffGroupId: '6' });
    assert.deepEqual(types('support-ticket', { parentChannelId: '19', staffGroupId: '6' }), [
      'trigger_command', 'condition', 'action_channelCreate', 'action_move', 'action_pokeGroup',
      'trigger_cron', 'action_tempChannelCleanup',
    ]);
    const command = flow.nodes.find((node) => node.type === 'trigger_command');
    const created = flow.nodes.find((node) => node.type === 'action_channelCreate');
    assert.equal(command?.config.command, '!support');
    assert.equal(command?.config.cooldownSeconds, 60);
    assert.equal(created?.config.trackTempChannel, true);
    assert.equal(created?.config.cpid, '19');
    assert.equal(flow.nodes.find((node) => node.type === 'action_pokeGroup')?.config.groupId, '6');
    assert.equal(BUILTIN_CHAT_COMMANDS.includes('support' as never), false);
  });

  it('builds a reminder from the command delay and a private message', () => {
    const flow = template('timed-reminder').flowDataFactory({});
    assert.deepEqual(types('timed-reminder', {}), ['trigger_command', 'condition', 'delay', 'action_message']);
    assert.equal(flow.nodes.find((node) => node.type === 'trigger_command')?.config.command, '!remind');
    assert.equal(flow.nodes.find((node) => node.type === 'delay')?.config.delayFromCommand, true);
    assert.equal(flow.nodes.find((node) => node.type === 'action_message')?.config.message, '{{event.command_args|dropFirst}}');
    assert.equal(BUILTIN_CHAT_COMMANDS.includes('remind' as never), false);
  });

  it('builds a scheduled announcement for the server or one channel, with a date placeholder', () => {
    const server = template('scheduled-announcement').flowDataFactory({
      message: 'Announcement {{time.date}}',
      cron: '0 9 * * *',
      timezone: 'UTC',
      audience: 'server',
    });
    assert.equal(server.nodes[0].config.cron, '0 9 * * *');
    assert.equal(server.nodes[1].config.targetMode, 'server');
    assert.match(server.nodes[1].config.message, /\{\{time\.date\}\}/);

    const channel = template('scheduled-announcement').flowDataFactory({
      message: 'Announcement {{time.date}}',
      cron: '0 * * * *',
      audience: 'channel',
      channelId: '12',
    });
    assert.equal(channel.nodes[1].config.targetMode, 'channel');
    assert.equal(channel.nodes[1].config.target, '12');
  });
});
