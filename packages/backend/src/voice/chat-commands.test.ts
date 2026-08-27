import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
    assert.equal(isReservedChatCommandName('PLAY'), true);
    assert.equal(isReservedChatCommandName('shuffle'), true);
    assert.equal(isReservedChatCommandName('rules'), false);
  });
});
