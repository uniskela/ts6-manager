import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BUILTIN_COMMAND_HELP } from '../chat-commands.js';
import { formatHelpMessage } from '../ts6-chat-format.js';
import {
  MAX_TS_COMMAND_BYTES,
  buildCommand,
  buildSendTextCommands,
  parseCommand,
} from './commands.js';

describe('sendtextmessage packet budget', () => {
  it('splits the built-in !help reply into single voice packets', () => {
    const msg = formatHelpMessage(BUILTIN_COMMAND_HELP, [
      { name: 'rules', description: 'Server rules' },
    ]);
    const whole = buildCommand('sendtextmessage', { targetmode: 2, msg });
    // #368: this reply was 2093 bytes and left the client as 5 UDP fragments,
    // which never showed up in the channel the bot sits in.
    assert.ok(
      Buffer.byteLength(whole, 'utf8') > MAX_TS_COMMAND_BYTES,
      `help command is ${Buffer.byteLength(whole)} bytes, expected it to exceed one packet`,
    );

    const commands = buildSendTextCommands(msg, 2);
    assert.ok(commands.length > 1);
    for (const cmd of commands) {
      assert.ok(Buffer.byteLength(cmd, 'utf8') <= MAX_TS_COMMAND_BYTES, cmd.slice(0, 80));
      assert.equal(cmd.includes('\n'), false);
    }
    assert.equal(commands.map((cmd) => parseCommand(cmd).params.msg).join(''), msg);
  });

  it('keeps a short channel message as one command and round-trips escapes', () => {
    const msg = 'Now playing: A & B\nnext';
    const commands = buildSendTextCommands(msg, 2);
    assert.equal(commands.length, 1);
    assert.equal(parseCommand(commands[0]!).params.msg, msg);
    assert.ok(Buffer.byteLength(commands[0]!, 'utf8') <= MAX_TS_COMMAND_BYTES);
  });

  it('keeps a private message target on every piece', () => {
    const msg = `${'word '.repeat(200)}\n${'tail '.repeat(200)}`;
    const commands = buildSendTextCommands(msg, 1, 3);
    assert.ok(commands.length > 1);
    for (const cmd of commands) {
      const parsed = parseCommand(cmd);
      assert.equal(parsed.params.targetmode, '1');
      assert.equal(parsed.params.target, '3');
      assert.ok(Buffer.byteLength(cmd, 'utf8') <= MAX_TS_COMMAND_BYTES);
    }
    assert.equal(commands.map((cmd) => parseCommand(cmd).params.msg).join(''), msg);
  });
});
