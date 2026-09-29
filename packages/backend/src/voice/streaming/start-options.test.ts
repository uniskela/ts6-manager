import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStreamStartOptions } from './start-options.js';

describe('parseStreamStartOptions', () => {
  it('accepts Auto, 4K presets, encoders and a one-session timeout', () => {
    const parsed = parseStreamStartOptions({
      preset: 'auto', encoder: 'h264_vaapi', framerate: '30', bitrate: '8000k', volume: 80, noViewerTimeoutSec: 60,
    });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.options, {
      preset: 'auto', encoder: 'h264_vaapi', framerate: 30, bitrate: '8000k', volume: 80, noViewerTimeoutSec: 60,
    });
    const fourK = parseStreamStartOptions({ preset: '2160p' });
    assert.ok(fourK.ok && fourK.options.preset === '2160p');
  });

  it('omits empty fields so admin defaults apply', () => {
    const parsed = parseStreamStartOptions({ preset: '', encoder: null, bitrate: '' });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.options, {});
    assert.deepEqual(parseStreamStartOptions(undefined), { ok: true, options: {} });
  });

  it('allows 0 to disable the no-viewer stop for one session', () => {
    const parsed = parseStreamStartOptions({ noViewerTimeoutSec: 0 });
    assert.ok(parsed.ok && parsed.options.noViewerTimeoutSec === 0);
  });

  it('rejects unknown or unsafe values', () => {
    for (const body of [
      { preset: '4k' },
      { encoder: 'nvenc' },
      { framerate: 240 },
      { bitrate: '1500k; rm -rf /' },
      { noViewerTimeoutSec: -5 },
      { noViewerTimeoutSec: 'soon' },
      { volume: 'loud' },
    ]) {
      assert.equal(parseStreamStartOptions(body).ok, false, JSON.stringify(body));
    }
  });

  it('never takes a LAN host allowance from the request body', () => {
    const parsed = parseStreamStartOptions({ preset: '720p', localHosts: ['192.168.1.20'] } as any);
    assert.ok(parsed.ok);
    assert.equal((parsed as any).options.localHosts, undefined);
  });
});
