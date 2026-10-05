import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BotMediaOverview } from '@ts6/common';
import { activeBots, activeBotsLabel, hubFacts, hubHeadline, hubLastStop, hubTone, queuePosition, videoDetails } from '../../src/lib/bot-hub';

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

describe('console Now playing details', () => {
  it('numbers the playing track within the queue', () => {
    assert.equal(queuePosition({ queue: [1, 2, 3, 4, 5, 6, 7, 8], currentIndex: 1 }), 'Track 2 of 8');
    assert.equal(queuePosition({ queue: [], currentIndex: -1 }), null);
    assert.equal(queuePosition({ queue: [1, 2], currentIndex: -1 }), null);
    assert.equal(queuePosition(undefined), null);
  });

  it('labels each video fact once', () => {
    const now = 1_000_000;
    const live = {
      ...base,
      video: {
        quality: { requested: 'auto', actual: '1080p' }, preset: '1080p',
        encoder: { requested: 'auto', selected: 'h264_vaapi', active: 'h264_vaapi', fallbackReason: null },
        sourceMode: 'live', health: { speed: 1.01, fps: 30 }, viewerCount: 3, startedAt: now - 65_000,
        noViewer: { stopAt: null, timeoutSec: 300 },
      },
    } as unknown as BotMediaOverview;
    assert.deepEqual(videoDetails(live, now).map((d) => d.label),
      ['Quality', 'Encoder', 'Source', 'Encode health', 'Viewers', 'Up for', 'Auto-stop']);
    assert.equal(videoDetails(live, now).find((d) => d.label === 'Viewers')?.value, '3 in channel');
    assert.equal(videoDetails(live, now).find((d) => d.label === 'Auto-stop')?.value, 'if no viewers for 5 min');
    assert.deepEqual(videoDetails(base, now), []);
  });
});

describe('active bots pill', () => {
  const music = (botId: number, status: string, title: string): BotMediaOverview => ({
    ...base, botId, status,
    session: { id: String(botId), kind: 'music', state: 'active', botId, botName: 'Aurora', startedAt: 0, label: title },
    music: { title, artist: null, live: false, position: 1, duration: 10 },
  });

  it('lists bots with a session, playing before paused, skipping idle and offline ones', () => {
    const paused = music(2, 'paused', 'Two');
    const playing = music(3, 'playing', 'Three');
    const offline = { ...music(4, 'stopped', 'Four') };
    assert.deepEqual(activeBots([base, paused, offline, playing]).map((b) => b.botId), [3, 2]);
  });

  it('labels one bot by its track and several by count', () => {
    assert.equal(activeBotsLabel([]), null);
    assert.equal(activeBotsLabel([music(2, 'playing', 'Two')]), 'Two');
    assert.equal(activeBotsLabel([music(2, 'playing', 'Two'), music(3, 'playing', 'Three')]), '2 active bots');
  });
});
