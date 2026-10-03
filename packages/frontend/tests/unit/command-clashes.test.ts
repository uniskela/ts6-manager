import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectFlowCommandNames,
  describeCommandClash,
  findCommandClashes,
  normalizeCommandName,
} from '../../src/lib/command-clashes';

describe('normalizeCommandName', () => {
  it('strips a leading bang and lowercases', () => {
    assert.equal(normalizeCommandName('!Play'), 'play');
    assert.equal(normalizeCommandName('!!TV'), 'tv');
    assert.equal(normalizeCommandName('  Stream  '), 'stream');
  });
});

describe('collectFlowCommandNames', () => {
  it('reads trigger_command config.command from editor-shaped flowData', () => {
    assert.deepEqual(
      collectFlowCommandNames([
        {
          flowData: {
            nodes: [
              { type: 'trigger_command', config: { command: '!Help' } },
              { type: 'trigger_event', config: { eventName: 'notifycliententerview' } },
              { type: 'action_message', config: { message: 'hi' } },
            ],
          },
        },
      ]),
      ['!Help'],
    );
  });

  it('reads engine-shaped command triggers', () => {
    assert.deepEqual(
      collectFlowCommandNames([
        {
          flowData: {
            nodes: [
              { type: 'trigger', data: { triggerType: 'command', commandName: 'rules' } },
            ],
          },
        },
      ]),
      ['rules'],
    );
  });
});

describe('findCommandClashes', () => {
  it('returns nothing when names are unique across sources', () => {
    assert.deepEqual(
      findCommandClashes({
        custom: ['rules', 'links'],
        flows: ['ticket'],
        builtins: ['play', 'tv', 'stream'],
      }),
      [],
    );
  });

  it('detects custom vs builtin ignoring case and bang', () => {
    assert.deepEqual(
      findCommandClashes({
        custom: ['!Play', 'rules'],
        flows: [],
        builtins: ['play', 'tv'],
      }),
      [{ name: 'play', sources: ['custom', 'builtin'] }],
    );
  });

  it('detects flow vs custom and three-way clashes', () => {
    assert.deepEqual(
      findCommandClashes({
        custom: ['rules', 'play'],
        flows: ['!RULES', 'ticket'],
        builtins: ['play', 'tv'],
      }),
      [
        { name: 'play', sources: ['custom', 'builtin'] },
        { name: 'rules', sources: ['custom', 'flow'] },
      ],
    );
  });

  it('detects flow vs builtin', () => {
    assert.deepEqual(
      findCommandClashes({
        custom: [],
        flows: ['!stream'],
        builtins: ['stream'],
      }),
      [{ name: 'stream', sources: ['flow', 'builtin'] }],
    );
  });
});

describe('describeCommandClash', () => {
  it('names the conflicting sources', () => {
    assert.equal(
      describeCommandClash({ name: 'play', sources: ['custom', 'builtin'] }),
      '!play is used as a custom reply and a built-in command',
    );
    assert.equal(
      describeCommandClash({ name: 'rules', sources: ['custom', 'flow', 'builtin'] }),
      '!rules is used as a custom reply, a flow command trigger, and a built-in command',
    );
  });
});

it('ignores missing flows, blank commands, and non-trigger engine nodes', () => {
  assert.deepEqual(collectFlowCommandNames([
    {}, { flowData: null },
    { flowData: { nodes: [
      { type: 'trigger_command', config: { command: '  ' } },
      { type: 'action_message', data: { triggerType: 'event', commandName: 'not-a-trigger' } },
      { type: 'trigger_command', config: { command: 123 } },
    ] } },
  ]), []);
});

it('groups a three-way clash once and ignores empty names and duplicate source entries', () => {
  assert.deepEqual(findCommandClashes({
    custom: ['!PLAY', 'play', '', '!'], flows: ['Play', 'play', 'ticket'], builtins: ['play', 'tv'],
  }), [{ name: 'play', sources: ['custom', 'flow', 'builtin'] }]);
});
