import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStreamHost, parseTwitchResolve } from './video-download.js';
import { resolveSourceMode } from './lifecycle.js';
import { validateUrl } from '../../utils/url-validator.js';

describe('classifyStreamHost', () => {
  it('detects YouTube hosts', () => {
    assert.equal(classifyStreamHost('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube');
    assert.equal(classifyStreamHost('https://youtu.be/dQw4w9WgXcQ'), 'youtube');
    assert.equal(classifyStreamHost('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube');
  });

  it('detects Twitch hosts (including www / clips)', () => {
    assert.equal(classifyStreamHost('https://www.twitch.tv/some_streamer'), 'twitch');
    assert.equal(classifyStreamHost('https://twitch.tv/some_streamer'), 'twitch');
    assert.equal(classifyStreamHost('https://clips.twitch.tv/ClipSlug'), 'twitch');
  });

  it('treats other URLs as other', () => {
    assert.equal(classifyStreamHost('https://example.com/live.m3u8'), 'other');
    assert.equal(classifyStreamHost('not a url'), 'other');
  });
});

describe('parseTwitchResolve', () => {
  it('marks is_live as live with no duration', () => {
    const r = parseTwitchResolve({
      url: 'https://cdn.example/live.m3u8',
      is_live: true,
      duration: 0,
    });
    assert.equal(r.path, 'https://cdn.example/live.m3u8');
    assert.equal(r.live, true);
    assert.equal(r.durationSec, null);
  });

  it('marks live_status is_live as live', () => {
    const r = parseTwitchResolve({
      url: 'https://cdn.example/index.m3u8',
      live_status: 'is_live',
    });
    assert.equal(r.live, true);
    assert.equal(r.durationSec, null);
  });

  it('parses VOD duration', () => {
    const r = parseTwitchResolve({
      url: 'https://cdn.example/vod.m3u8',
      is_live: false,
      duration: 600,
    });
    assert.equal(r.live, false);
    assert.equal(r.durationSec, 600);
  });

  it('rejects missing or non-http url', () => {
    assert.throws(() => parseTwitchResolve({}), /playable Twitch stream URL/);
    assert.throws(
      () => parseTwitchResolve({ url: 'file:///tmp/x' }),
      /playable Twitch stream URL/,
    );
  });
});

describe('Twitch resolved media URL SSRF gate', () => {
  // resolveTwitchStreamUrl re-validates parseTwitchResolve().path with the same
  // validateUrl options (no LAN allowlist) before returning to ffmpeg.
  it('blocks private and metadata addresses that yt-dlp could return', async () => {
    const blocked = [
      'http://127.0.0.1/live.m3u8',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.10/stream.m3u8',
    ];
    for (const url of blocked) {
      const check = await validateUrl(url, { allowedProtocols: ['http:', 'https:'] });
      assert.equal(check.valid, false, url);
    }
  });
});

describe('Twitch live hint for fixed presets', () => {
  it('extractor live hint maps auto/fixed-preset (no probe) remote to live', () => {
    // Fixed presets skip ffprobe; applyVideoSource passes this hint instead.
    const hint = { durationSec: null as number | null };
    assert.equal(resolveSourceMode('auto', false, hint), 'live');
    assert.equal(resolveSourceMode(undefined, false, hint), 'live');
  });

  it('extractor VOD hint with unknown duration still maps to vod', () => {
    const hint = { durationSec: 0 };
    assert.equal(resolveSourceMode('auto', false, hint), 'vod');
  });
});
