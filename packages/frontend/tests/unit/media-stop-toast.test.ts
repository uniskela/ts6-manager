import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BotMediaOverview } from '@ts6/common';
import {
  applyMediaStopToastDelta,
  collectToastableStops,
  mediaStopToastKey,
} from '../../src/lib/media-stop-toast';

const base: BotMediaOverview = {
  botId: 1, botName: 'Aurora', serverConfigId: 1, serverName: 'Ops', status: 'connected',
  channelId: 1, channelName: 'Lobby', session: null, music: null, video: null,
  lastMusicStop: null, lastVideoStop: null,
};

describe('media stop toasts', () => {
  // The hook runs on every signed-in page, so a body that is not a list (an
  // error page, a proxy reply, an older backend) must not take the app down.
  it('ignores a bot-media reply that is not a list', () => {
    const seen = new Set(['1:video:source_unreachable:1000'] as const);
    const toasts: unknown[] = [];
    for (const reply of [{ error: 'nope' }, null, undefined, 'html']) {
      const next = applyMediaStopToastDelta(reply as unknown as BotMediaOverview[], seen, { toast: (t) => toasts.push(t) });
      assert.deepEqual([...next], [...seen]);
    }
    assert.equal(toasts.length, 0);
  });

  it('collects unreachable video stops and skips manual ones', () => {
    const bot: BotMediaOverview = {
      ...base,
      lastVideoStop: {
        reason: 'source_unreachable',
        at: 1000,
        detail: 'This channel uses DRM encryption and cannot be played here',
      },
      lastMusicStop: { reason: 'manual', at: 2000, detail: 'Stopped from the web UI' },
    };
    const items = collectToastableStops(bot);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'video');
    assert.equal(items[0].key, mediaStopToastKey(1, 'video', bot.lastVideoStop!));
  });

  it('seeds without toasting, then toasts on new stops', () => {
    const toasted: string[] = [];
    const first = applyMediaStopToastDelta(
      [{
        ...base,
        lastVideoStop: { reason: 'no_viewers', at: 500, detail: 'Stopped after 5 minutes with no viewers' },
      }],
      new Set(),
      { toast: (o) => toasted.push(`${o.botName}:${o.kind}`) },
    );
    assert.equal(toasted.length, 0);
    assert.equal(first.size, 1);

    const second = applyMediaStopToastDelta(
      [{
        ...base,
        lastVideoStop: {
          reason: 'source_unreachable',
          at: 900,
          detail: 'This channel uses DRM encryption and cannot be played here',
        },
      }],
      first,
      { toast: (o) => toasted.push(`${o.botName}:${o.kind}:${o.stop.reason}`) },
    );
    assert.deepEqual(toasted, ['Aurora:video:source_unreachable']);
    assert.equal(second.size, 2);
  });
});
