import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatHelpMessage,
  formatNowPlayingMessage,
  formatQueueMessage,
} from './ts6-chat-format.js';

describe('ts6-chat-format', () => {
  it('formats now playing with controls block', () => {
    const msg = formatNowPlayingMessage({
      title: 'Song',
      artist: 'Artist',
      position: 90,
      duration: 200,
      upcoming: [{ title: 'Next', artist: 'A' }],
      totalQueueLength: 3,
      includeControls: true,
    });
    assert.ok(msg.includes('## 🎵 Now Playing'));
    assert.ok(msg.includes('**Song**'));
    assert.ok(msg.includes('1:30 / 3:20'));
    assert.ok(msg.includes('### Up Next'));
    assert.ok(msg.includes('<details>'));
    assert.ok(msg.includes('!pause'));
  });

  it('formats help with custom commands', () => {
    const msg = formatHelpMessage(
      [{ usage: '!play <url>', blurb: 'Play URL' }],
      [{ name: 'rules', description: 'Server rules' }],
    );
    assert.ok(msg.includes('### Built-in'));
    assert.ok(msg.includes('!play <url>'));
    assert.ok(msg.includes('### Custom'));
    assert.ok(msg.includes('!rules'));
    assert.ok(msg.includes('@Bot 2'), 'explains how to pick a bot');
    assert.ok(!msg.includes('### This bot'), 'no automation section unless the bot has it on');
  });

  it('tells listeners when the answering bot has Auto-DJ or 24/7 on', () => {
    const builtin = [{ usage: '!play <url>', blurb: 'Play URL' }];
    const both = formatHelpMessage(builtin, [], { autoDj: true, sourceKind: 'radio', stayInChannel: true, playing: false });
    assert.ok(both.includes('### This bot'));
    assert.ok(both.includes('**Auto-DJ is on** — when nothing is queued it plays a radio station.'));
    assert.ok(both.includes('Your requests always play first.'));
    assert.ok(both.includes('**24/7 is on**'));

    const withCustom = formatHelpMessage(builtin, [{ name: 'rules', description: 'Server rules' }],
      { autoDj: true, sourceKind: 'playlist', stayInChannel: false, playing: false });
    assert.ok(withCustom.indexOf('### This bot') > withCustom.indexOf('### Custom'), 'the bot section closes the message');
    assert.ok(withCustom.trimEnd().endsWith('Your requests always play first.'));

    const playlistOnly = formatHelpMessage(builtin, [], { autoDj: true, sourceKind: 'playlist', stayInChannel: false, playing: true });
    assert.ok(playlistOnly.includes('plays a saved playlist'));
    assert.ok(!playlistOnly.includes('24/7'));

    const presenceOnly = formatHelpMessage(builtin, [], { autoDj: false, sourceKind: null, stayInChannel: true, playing: false });
    assert.ok(presenceOnly.includes('**24/7 is on**'));
    assert.ok(!presenceOnly.includes('Auto-DJ'));

    for (const off of [null, undefined, { autoDj: false, sourceKind: null, stayInChannel: false, playing: false }] as const) {
      assert.ok(!formatHelpMessage(builtin, [], off).includes('### This bot'));
    }
  });

  it('formats queue with current marker', () => {
    const msg = formatQueueMessage(
      [
        { title: 'A', artist: 'One' },
        { title: 'B', artist: 'Two' },
      ],
      1,
    );
    assert.ok(msg.includes('▶️'));
    assert.ok(msg.includes('**2.**'));
  });
});
