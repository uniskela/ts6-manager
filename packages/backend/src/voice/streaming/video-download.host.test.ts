import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStreamHost } from './video-download.js';

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
