import { describe, expect, it } from 'vitest';
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
    expect(msg).toContain('## 🎵 Now Playing');
    expect(msg).toContain('**Song**');
    expect(msg).toContain('1:30 / 3:20');
    expect(msg).toContain('### Up Next');
    expect(msg).toContain('<details>');
    expect(msg).toContain('!pause');
  });

  it('formats help with custom commands', () => {
    const msg = formatHelpMessage(
      [{ usage: '!play <url>', blurb: 'Play URL' }],
      [{ name: 'rules', description: 'Server rules' }],
    );
    expect(msg).toContain('### Built-in');
    expect(msg).toContain('!play <url>');
    expect(msg).toContain('### Custom');
    expect(msg).toContain('!rules');
  });

  it('formats queue with current marker', () => {
    const msg = formatQueueMessage(
      [
        { title: 'A', artist: 'One' },
        { title: 'B', artist: 'Two' },
      ],
      1,
    );
    expect(msg).toContain('▶️');
    expect(msg).toContain('**2.**');
  });
});
