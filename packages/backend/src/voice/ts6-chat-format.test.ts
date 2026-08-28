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
