import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request } from 'express';
import { LISTENER_MAX_DURATION_SEC } from '../../voice/audio/listener-music.js';
import { ListenerRemoteError, ListenerRemoteService, type Binding } from '../../voice/listener-remote.js';
import type { QueueItem } from '../../voice/playlist/queue.js';
import { assertQueueRoom } from './append.js';
import { listenerDurationApiCode, refuseListenerDuration } from './duration.js';
import { resolveListenerLink, type ListenerLinkProbe } from './link.js';

const binding: Binding = { botId: 7, serverConfigId: 1, virtualServerId: 1, channelId: 3, clid: 9, uid: 'uid' };
const item: QueueItem = { id: 'track', title: 'Track', duration: 180, filePath: '/music/track.mp3', source: 'youtube' };

function rejects(fn: () => unknown, status: number, code: string) {
  assert.throws(fn, (err: unknown) => err instanceof ListenerRemoteError && err.status === status && err.code === code);
}

async function request(
  downloadTrack: () => Promise<QueueItem>,
  probe: ListenerLinkProbe = async () => ({ durationSec: item.duration ?? 180 }),
): Promise<Request> {
  const listenerRemote = new ListenerRemoteService();
  const { session } = await listenerRemote.exchange(listenerRemote.issue(binding).token, async () => true);
  return {
    get: () => `Bearer ${session}`,
    app: {
      locals: {
        listenerRemote,
        listenerLinkProbe: probe,
        mediaUrlPipelineDeps: {
          resolveSpotify: async (url: string) => url,
          resolveAppleMusic: async () => ({ tracks: [] }),
          resolveSpotifyCollection: async () => null,
          appleTrackToYouTube: async () => null,
          expandYouTube: async () => null,
          downloadTrack,
        },
      },
    },
  } as unknown as Request;
}

describe('listener remote helpers', () => {
  it('assertQueueRoom limits upcoming tracks and the whole queue', () => {
    assert.doesNotThrow(() => assertQueueRoom({ queue: { upcomingCount: 499, length: 4999 } }));
    rejects(() => assertQueueRoom({ queue: { upcomingCount: 500, length: 500 } }), 409, 'queue_full');
    rejects(() => assertQueueRoom({ queue: { upcomingCount: 0, length: 5000 } }), 409, 'queue_full');
  });

  it('resolveListenerLink rejects links with credentials before resolving', async () => {
    let downloads = 0;
    const req = await request(async () => { downloads++; return item; });
    await assert.rejects(resolveListenerLink(req, binding, 'https://user:secret@8.8.8.8/media'),
      (err: unknown) => err instanceof ListenerRemoteError && err.status === 400 && err.code === 'invalid_request');
    assert.equal(downloads, 0);
  });

  it('resolveListenerLink resolves one link per bot at a time and releases the lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const req = await request(async () => { await gate; return item; });
    const first = resolveListenerLink(req, binding, 'https://8.8.8.8/media?id=1');
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(resolveListenerLink(req, binding, 'https://8.8.8.8/media?id=2'),
      (err: unknown) => err instanceof ListenerRemoteError && err.status === 429 && err.code === 'rate_limited');
    release();
    assert.equal(await first, item);
    assert.equal(await resolveListenerLink(req, binding, 'https://8.8.8.8/media?id=3'), item);
  });

  it('refuseListenerDuration maps unknown_duration to duration_unknown and allows 900s', () => {
    assert.equal(listenerDurationApiCode('unknown_duration'), 'duration_unknown');
    assert.doesNotThrow(() => refuseListenerDuration({ durationSec: LISTENER_MAX_DURATION_SEC }));
    rejects(() => refuseListenerDuration({ durationSec: LISTENER_MAX_DURATION_SEC + 1 }), 422, 'too_long');
    rejects(() => refuseListenerDuration({ durationSec: 60, isLive: true }), 422, 'live_not_allowed');
    rejects(() => refuseListenerDuration({ durationSec: null }), 422, 'duration_unknown');
  });

  it('resolveListenerLink refuses before download when the probe fails the duration rules', async () => {
    let downloads = 0;
    const req = await request(
      async () => { downloads++; return item; },
      async () => ({ durationSec: LISTENER_MAX_DURATION_SEC + 1 }),
    );
    await assert.rejects(
      resolveListenerLink(req, binding, 'https://8.8.8.8/media?id=long'),
      (err: unknown) => err instanceof ListenerRemoteError && err.status === 422 && err.code === 'too_long',
    );
    assert.equal(downloads, 0);
  });

  it('resolveListenerLink refuses after download when the measured duration exceeds the limit', async () => {
    const req = await request(
      async () => ({ ...item, duration: LISTENER_MAX_DURATION_SEC + 1 }),
      async () => ({ durationSec: 600 }),
    );
    await assert.rejects(
      resolveListenerLink(req, binding, 'https://8.8.8.8/media?id=mismatch'),
      (err: unknown) => err instanceof ListenerRemoteError && err.status === 422 && err.code === 'too_long',
    );
  });

  it('maps MediaCache measured-duration refusals onto listener 422 codes', async () => {
    const { MediaCacheError } = await import('../../voice/audio/media-cache.js');
    const req = await request(
      async () => { throw new MediaCacheError('The downloaded file is longer than the allowed limit.', 'too_long'); },
      async () => ({ durationSec: 600 }),
    );
    await assert.rejects(
      resolveListenerLink(req, binding, 'https://8.8.8.8/media?id=cache-too-long'),
      (err: unknown) => err instanceof ListenerRemoteError && err.status === 422 && err.code === 'too_long',
    );
    const unknownReq = await request(
      async () => { throw new MediaCacheError('The length of the downloaded file could not be read.', 'duration_unknown'); },
      async () => ({ durationSec: 600 }),
    );
    await assert.rejects(
      resolveListenerLink(unknownReq, binding, 'https://8.8.8.8/media?id=cache-unknown'),
      (err: unknown) => err instanceof ListenerRemoteError && err.status === 422 && err.code === 'duration_unknown',
    );
  });
});
