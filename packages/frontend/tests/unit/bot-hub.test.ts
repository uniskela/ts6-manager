import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BotMediaOverview } from '@ts6/common';
import { hubFacts, hubHeadline, hubLastStop, hubTone } from '../../src/lib/bot-hub';

const base: BotMediaOverview = {
  botId: 1, botName: 'Aurora', serverConfigId: 1, serverName: 'Ops', status: 'connected',
  channelId: 1, channelName: 'Lobby', session: null, music: null, video: null,
  lastMusicStop: null, lastVideoStop: null,
};

describe('bot hub wording', () => {
  it('describes idle, offline and music bots', () => {
    assert.equal(hubTone(base), 'idle');
    assert.equal(hubHeadline(base), 'Idle');
    assert.equal(hubTone({ ...base, status: 'stopped' }), 'offline');
    const music: BotMediaOverview = {
      ...base, status: 'playing',
      session: { id: 'a', kind: 'music', state: 'active', botId: 1, botName: 'Aurora', startedAt: 0, label: 'Song' },
      music: { title: 'Song', artist: 'Band', live: false, position: 65, duration: 200 },
    };
    assert.equal(hubTone(music), 'music');
    assert.equal(hubHeadline(music), 'Song — Band');
    assert.deepEqual(hubFacts(music, 0), ['1:05 / 3:20']);
  });

  it('shows starting streams and the newest stop reason', () => {
    const starting: BotMediaOverview = {
      ...base,
      session: { id: 'b', kind: 'video', state: 'starting', botId: 1, botName: 'Aurora', startedAt: null, label: 'iptv.example' },
    };
    assert.equal(hubHeadline(starting), 'Starting stream from iptv.example…');
    const now = 1_000_000;
    const stopped: BotMediaOverview = {
      ...base,
      lastMusicStop: { reason: 'replaced_by_video', at: now - 20 * 60_000, detail: 'Replaced by a video stream' },
      lastVideoStop: { reason: 'no_viewers', at: now - 2 * 60_000, detail: 'Stopped after 5 minutes with no viewers' },
    };
    assert.equal(hubLastStop(stopped, now), 'Last stream: Stopped after 5 minutes with no viewers · 2 min ago');
  });
});
