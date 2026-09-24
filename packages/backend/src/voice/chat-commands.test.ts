import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import {
  BUILTIN_CHAT_COMMANDS,
  BUILTIN_COMMAND_HELP,
  CHAT_COMMAND_PRESETS,
  isReservedChatCommandName,
  normalizeChatCommandName,
} from './chat-commands.js';

describe('normalizeChatCommandName', () => {
  it('strips bang and lowercases', () => {
    assert.equal(normalizeChatCommandName('!Rules'), 'rules');
    assert.equal(normalizeChatCommandName('  Hello_World  '), 'hello_world');
  });

  it('rejects invalid characters', () => {
    assert.equal(normalizeChatCommandName('foo bar'), 'foobar');
    assert.equal(normalizeChatCommandName('!!!'), '');
  });
});

describe('isReservedChatCommandName', () => {
  it('reserves built-ins including help', () => {
    assert.equal(isReservedChatCommandName('help'), true);
    assert.equal(isReservedChatCommandName('here'), true);
    assert.equal(isReservedChatCommandName('come'), true);
    assert.equal(isReservedChatCommandName('PLAY'), true);
    assert.equal(isReservedChatCommandName('shuffle'), true);
    assert.equal(isReservedChatCommandName('rules'), false);
  });
});


describe('CHAT_COMMAND_PRESETS', () => {
  test('includes recommended canned-reply names without colliding with built-ins', () => {
    const names = CHAT_COMMAND_PRESETS.map((p) => p.name);
    assert.deepEqual(names.sort(), ['about', 'discord', 'info', 'links', 'rules'].sort());
    for (const preset of CHAT_COMMAND_PRESETS) {
      assert.ok(preset.response.trim().length > 0);
      assert.ok(preset.description.trim().length > 0);
      assert.equal(isReservedChatCommandName(preset.name), false);
      assert.ok(!BUILTIN_CHAT_COMMANDS.includes(preset.name as never));
    }
  });

  test('!commands is documented as built-in help', () => {
    assert.ok(BUILTIN_COMMAND_HELP.some((h) => h.name === 'commands'));
  });
});
