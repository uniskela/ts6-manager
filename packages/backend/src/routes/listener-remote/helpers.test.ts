import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request } from 'express';
import { ListenerRemoteError, ListenerRemoteService, type Binding } from '../../voice/listener-remote.js';
import type { QueueItem } from '../../voice/playlist/queue.js';
import { assertQueueRoom } from './append.js';
import { resolveListenerLink } from './link.js';

const binding: Binding = { botId: 7, serverConfigId: 1, virtualServerId: 1, channelId: 3, clid: 9, uid: 'uid' };
const item: QueueItem = { id: 'track', title: 'Track', filePath: '/music/track.mp3', source: 'youtube' };

function rejects(fn: () => unknown, status: number, code: string) {
  assert.throws(fn, (err: unknown) => err instanceof ListenerRemoteError && err.status === status && err.code === code);
}

function request(downloadTrack: () => Promise<QueueItem>): Request {
  const listenerRemote = new ListenerRemoteService();
  return {
    get: () => `Bearer ${'a'.repeat(43)}`,
    app: {
      locals: {
        listenerRemote,
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
    rejects(() => assertQueueRoom({ queue: { upcomingCount: 500, length: 500 } }), 429, 'rate_limited');
    rejects(() => assertQueueRoom({ queue: { upcomingCount: 0, length: 5000 } }), 429, 'rate_limited');
  });

  it('resolveListenerLink rejects links with credentials before resolving', async () => {
    let downloads = 0;
    const req = request(async () => { downloads++; return item; });
    await assert.rejects(resolveListenerLink(req, binding, 'https://user:secret@8.8.8.8/media'),
      (err: unknown) => err instanceof ListenerRemoteError && err.status === 400 && err.code === 'invalid_request');
    assert.equal(downloads, 0);
  });

  it('resolveListenerLink resolves one link per bot at a time and releases the lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const req = request(async () => { await gate; return item; });
    const first = resolveListenerLink(req, binding, 'https://8.8.8.8/media?id=1');
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(resolveListenerLink(req, binding, 'https://8.8.8.8/media?id=2'),
      (err: unknown) => err instanceof ListenerRemoteError && err.status === 429 && err.code === 'rate_limited');
    release();
    assert.equal(await first, item);
    assert.equal(await resolveListenerLink(req, binding, 'https://8.8.8.8/media?id=3'), item);
  });
});
