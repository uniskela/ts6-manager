import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { MediaEgressError } from '../egress/media-egress.js';
import {
  RADIO_FETCHER_BUSY,
  RADIO_FETCHER_UNAVAILABLE,
} from '../egress/media-fetcher-client.js';
import { PlayQueue } from '../playlist/queue.js';
import type { CommandContext } from './context.js';
import {
  formatRadioPlayFailure,
  handleRadio,
  RADIO_PLAY_FAILED_GENERIC,
} from './playback.js';
import { beginChatMediaRequest, invalidateChatPlaylistExpansion } from './queue.js';

const BOT_ID = 7;
const USER_CLID = 42;

afterEach(() => {
  // Drop leftover chat-media generation state between cases.
  invalidateChatPlaylistExpansion(BOT_ID);
});

describe('formatRadioPlayFailure', () => {
  it('allowlists busy and unavailable MediaEgressError texts', () => {
    assert.equal(
      formatRadioPlayFailure(new MediaEgressError(RADIO_FETCHER_BUSY)),
      `Failed to play: ${RADIO_FETCHER_BUSY}`,
    );
    assert.equal(
      formatRadioPlayFailure(new MediaEgressError(RADIO_FETCHER_UNAVAILABLE)),
      `Failed to play: ${RADIO_FETCHER_UNAVAILABLE}`,
    );
  });

  it('hides unexpected errors behind a generic message', () => {
    assert.equal(
      formatRadioPlayFailure(new Error('ENOENT /secret/path token=abc')),
      RADIO_PLAY_FAILED_GENERIC,
    );
    assert.equal(
      formatRadioPlayFailure(new MediaEgressError('ffmpeg failed open https://u:p@h/x')),
      RADIO_PLAY_FAILED_GENERIC,
    );
  });
});

describe('handleRadio play outcomes', () => {
  function makeFixture(opts?: {
    playStream?: (item: unknown) => Promise<unknown>;
    replyImpl?: (msg: string) => Promise<void> | void;
  }) {
    const replies: string[] = [];
    const station = { id: 3, name: 'Jazz FM', url: 'https://203.0.113.10/live', genre: 'Jazz' };
    const bot: any = {
      currentConfig: { id: BOT_ID, serverConfigId: 9 },
      queue: new PlayQueue(),
      nowPlaying: null as unknown,
      stopAudio() {
        this.nowPlaying = null;
      },
      playStream: opts?.playStream ?? (async (item: unknown) => {
        bot.nowPlaying = item;
        return [];
      }),
    };
    const context = {
      prisma: {
        musicBot: { findUnique: async () => ({ serverConfigId: 9 }) },
        radioStation: {
          findMany: async () => [station],
        },
      },
      voiceBotManager: { getBot: () => bot },
      virtualServerIdForBot: () => 1,
      joinChannelForCommand: async () => {},
      chatMusicSwitch: () => ({ replaceSessionIds: [] as string[] }),
      saveMusicRequest: () => {},
      reply: async (_b: unknown, _clid: number, msg: string) => {
        if (opts?.replyImpl) await opts.replyImpl(msg);
        else replies.push(msg);
      },
    } as unknown as CommandContext;
    return { bot, context, replies, station };
  }

  it('replies with the capacity message when the fetcher is busy', async () => {
    const f = makeFixture({
      playStream: async () => {
        throw new MediaEgressError(RADIO_FETCHER_BUSY);
      },
    });
    await handleRadio(f.context, BOT_ID, f.bot, USER_CLID, '3');
    assert.deepEqual(f.replies, [`Failed to play: ${RADIO_FETCHER_BUSY}`]);
    assert.doesNotMatch(f.replies[0]!, /isolated media fetcher/);
  });

  it('replies with the unavailable message when the fetcher is missing', async () => {
    const f = makeFixture({
      playStream: async () => {
        throw new MediaEgressError(RADIO_FETCHER_UNAVAILABLE);
      },
    });
    await handleRadio(f.context, BOT_ID, f.bot, USER_CLID, '3');
    assert.deepEqual(f.replies, [`Failed to play: ${RADIO_FETCHER_UNAVAILABLE}`]);
  });

  it('uses a generic message for unexpected play failures', async () => {
    const f = makeFixture({
      playStream: async () => {
        throw new Error('ENOENT /etc/shadow token=leak');
      },
    });
    await handleRadio(f.context, BOT_ID, f.bot, USER_CLID, '3');
    assert.deepEqual(f.replies, [RADIO_PLAY_FAILED_GENERIC]);
    assert.doesNotMatch(f.replies.join('\n'), /shadow|token=leak/);
  });

  it('keeps the success reply unchanged', async () => {
    const f = makeFixture();
    await handleRadio(f.context, BOT_ID, f.bot, USER_CLID, '3');
    assert.deepEqual(f.replies, ['Now playing: Jazz FM']);
    assert.equal(f.bot.nowPlaying?.title, 'Jazz FM');
  });

  it('sends exactly one reply per failed play', async () => {
    const f = makeFixture({
      playStream: async () => {
        throw new MediaEgressError(RADIO_FETCHER_BUSY);
      },
    });
    await handleRadio(f.context, BOT_ID, f.bot, USER_CLID, '3');
    assert.equal(f.replies.length, 1);
  });

  it('does not reply when the request is superseded during playStream', async () => {
    const f = makeFixture({
      playStream: async () => {
        invalidateChatPlaylistExpansion(BOT_ID);
        throw new MediaEgressError(RADIO_FETCHER_BUSY);
      },
    });
    await handleRadio(f.context, BOT_ID, f.bot, USER_CLID, '3');
    assert.deepEqual(f.replies, []);
  });

  it('handles reply Promise rejection without duplicate replies or unhandled rejection', async () => {
    let attempts = 0;
    const f = makeFixture({
      playStream: async () => {
        throw new MediaEgressError(RADIO_FETCHER_BUSY);
      },
      replyImpl: async () => {
        attempts += 1;
        throw new Error('ts send failed');
      },
    });
    await assert.doesNotReject(() => handleRadio(f.context, BOT_ID, f.bot, USER_CLID, '3'));
    assert.equal(attempts, 1);
  });

  it('does not reply after a cancelled join before accept', async () => {
    const f = makeFixture();
    const originalJoin = f.context.joinChannelForCommand.bind(f.context);
    f.context.joinChannelForCommand = async (...args) => {
      // Cancel provisional work before accept by starting+accepting a peer.
      const peer = beginChatMediaRequest(BOT_ID);
      peer.accept();
      return originalJoin(...args);
    };
    await handleRadio(f.context, BOT_ID, f.bot, USER_CLID, '3');
    assert.deepEqual(f.replies, []);
    assert.equal(f.bot.nowPlaying, null);
  });
});
