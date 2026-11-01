import { formatNowPlayingMessage, formatQueueMessage } from '../voice/ts6-chat-format.js';
import type { QueueItem } from '../voice/playlist/queue.js';
import type { PlayQueue } from '../voice/playlist/queue.js';

const QUEUE_LINES = 15;

export type InspectableBot = {
  status: string;
  nowPlaying: QueueItem | null;
  playbackProgress?: { position?: number; duration?: number } | null;
  queue: PlayQueue;
};

export function formatBotNowPlaying(bot: InspectableBot): string {
  const np = bot.nowPlaying;
  if (!np) return '_Nothing is playing._';
  const progress = bot.playbackProgress;
  return formatNowPlayingMessage({
    title: np.title,
    artist: np.artist,
    position: progress?.position,
    duration: progress?.duration ?? np.duration,
    paused: bot.status === 'paused',
    upcoming: bot.queue.upcoming(5).map((item) => ({
      title: item.title,
      artist: item.artist,
      duration: item.duration,
    })),
    totalQueueLength: bot.queue.length,
    queueIndex: bot.queue.index,
    includeControls: false,
  });
}

export function formatBotQueue(bot: InspectableBot): string {
  const items = bot.queue.getAll();
  const start = Math.max(0, Math.min(bot.queue.index - 2, items.length - QUEUE_LINES));
  return formatQueueMessage(
    items.map((item) => ({ title: item.title, artist: item.artist, duration: item.duration })),
    bot.queue.index,
    QUEUE_LINES,
    { start, numberOffset: bot.queue.pruned },
  );
}
