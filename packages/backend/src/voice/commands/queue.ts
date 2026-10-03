import type { VoiceBot } from '../voice-bot.js';
import type { QueueItem } from '../playlist/queue.js';
import { defaultMediaUrlDeps, runMediaUrlPipeline } from '../media-url-pipeline.js';
import { formatQueueMessage } from '../ts6-chat-format.js';
import type { CommandContext } from './context.js';
/** Cancels stale background playlist expansions for chat !play / !queue. */
const chatPlaylistGeneration = new Map<number, number>();

/** Advance a bot’s generation so pending background playlist work is discarded. */
export function invalidateChatPlaylistExpansion(botId: number): void {
  chatPlaylistGeneration.set(botId, (chatPlaylistGeneration.get(botId) ?? 0) + 1);
}

/**
 * Resolve Spotify / Apple Music / YouTube Music / playlist URLs, download the first track,
 * and queue the rest in the background (same approach as play-url).
 */
export async function enqueueMediaUrl(
  context: CommandContext,
  botId: number,
  bot: VoiceBot,
  userClid: number,
  rawUrl: string,
): Promise<void> {
  await context.joinChannelForCommand(botId, bot, userClid);
  const generation = (chatPlaylistGeneration.get(botId) ?? 0) + 1;
  chatPlaylistGeneration.set(botId, generation);
  let firstCall = true;
  let alreadyPlaying = false;

  const result = await runMediaUrlPipeline(
    defaultMediaUrlDeps(),
    {
      play: async (item, opts) => {
        const isFirst = firstCall;
        firstCall = false;
        const live = context.voiceBotManager.getBot(botId);
        if (!live || chatPlaylistGeneration.get(botId) !== generation) return;
        if (isFirst) alreadyPlaying = live.status === 'playing' || live.status === 'paused';
        live.queue.add(item);
        context.saveMusicRequest(live, item);
        if (isFirst && alreadyPlaying) return;
        live.queue.playAt(live.queue.length - 1);
        if (isFirst) {
          await live.play(item, context.chatMusicSwitch(live));
        } else {
          await live.play(item).catch((err) => {
            console.error('[MusicCmd] Failed to resume playlist playback:', err);
          });
        }
      },
      enqueue: (item) => {
        if (chatPlaylistGeneration.get(botId) !== generation) return;
        const live = context.voiceBotManager.getBot(botId);
        if (!live || live.status === 'stopped' || live.status === 'error') return;
        live.queue.add(item);
        context.saveMusicRequest(live, item);
      },
      isIdle: () => {
        const live = context.voiceBotManager.getBot(botId);
        return Boolean(live && live.status === 'connected' && !live.nowPlaying);
      },
      isCancelled: () => chatPlaylistGeneration.get(botId) !== generation,
    },
    { url: rawUrl, enqueueOnly: false },
    {
      onBackgroundError: (err, label) => {
        console.error('[MusicCmd] Failed to queue %s:', label, err);
      },
    },
  );

  const pendingTotal = result.queuedInBackground;
  const playlistNote =
    pendingTotal > 0
      ? ` (+${pendingTotal} more from${result.playlistTitle ? ` "${result.playlistTitle}"` : ' playlist'})`
      : '';

  if (alreadyPlaying) {
    context.reply(
      bot,
      userClid,
      `Queued: ${result.first.artist} - ${result.first.title} (position #${bot.queue.length})${playlistNote}`,
    );
  } else {
    context.reply(bot, userClid, `Now playing: ${result.first.artist} - ${result.first.title}${playlistNote}`);
  }
}

/** Resolve a server or shared playlist by ID or name and append its tracks in order. */
export async function handlePlaylist(
  context: CommandContext,
  botId: number,
  bot: VoiceBot,
  userClid: number,
  args: string,
): Promise<void> {
  const serverConfigId = bot.currentConfig.serverConfigId;
  if (!serverConfigId) { context.reply(bot, userClid, 'No server configured.'); return; }
  const where = { OR: [{ serverConfigId }, { serverConfigId: null }] };
  const playlists = await context.prisma.playlist.findMany({
    where, select: { id: true, name: true }, orderBy: { name: 'asc' },
  });
  const query = args.trim().toLowerCase();
  if (!query) {
    context.reply(bot, userClid, playlists.length
      ? 'Playlists (first 10):\n' + playlists.slice(0, 10).map(p => `[${p.id}] ${p.name.slice(0, 60)}`).join('\n')
      : 'No playlists configured for this bot/server.');
    return;
  }
  const byId = /^\d+$/.test(query) ? playlists.filter(p => p.id === Number(query)) : [];
  const exact = playlists.filter(p => p.name.toLowerCase() === query);
  const matches = byId.length ? byId : exact.length ? exact : playlists.filter(p => p.name.toLowerCase().includes(query));
  if (matches.length !== 1) {
    context.reply(bot, userClid, matches.length
      ? 'Ambiguous playlist; use an ID: ' + matches.slice(0, 5).map(p => `[${p.id}] ${p.name.slice(0, 60)}`).join(', ')
      : 'Playlist not found. Use !playlist to list.');
    return;
  }
  const playlist = await context.prisma.playlist.findFirst({
    where: { ...where, id: matches[0].id },
    include: { songs: { include: { song: true }, orderBy: { position: 'asc' } } },
  });
  if (!playlist?.songs.length) { context.reply(bot, userClid, 'Playlist is empty.'); return; }
  const items: QueueItem[] = playlist.songs.map(({ song }) => ({
    id: String(song.id), title: song.title, artist: song.artist ?? undefined,
    duration: song.duration ?? undefined, filePath: song.filePath,
    source: song.source as QueueItem['source'], sourceUrl: song.sourceUrl ?? undefined,
  }));
  bot.queue.addMany(items);
  if (bot.status === 'connected' && !bot.nowPlaying) {
    const first = bot.queue.playAt(bot.queue.index < 0 ? 0 : bot.queue.index + 1);
    if (first) await bot.play(first, context.chatMusicSwitch(bot)); // VoiceBot owns local/stream playlist resolution.
  }
  context.reply(bot, userClid, `Queued playlist "${playlist.name.slice(0, 60)}" (${items.length} tracks).`);
}

/** Report or set the queue repeat mode after validating the requested mode. */
export function handleRepeat(context: CommandContext, bot: VoiceBot, userClid: number, args: string): void {
  const mode = args.trim().toLowerCase();
  if (mode && mode !== 'off' && mode !== 'track' && mode !== 'queue') {
    context.reply(bot, userClid, 'Usage: !repeat [off|track|queue]'); return;
  }
  if (mode === 'off' || mode === 'track' || mode === 'queue') bot.queue.setRepeat(mode);
  context.reply(bot, userClid, `Repeat mode: ${bot.queue.repeat}`);
}

/** Remove one unambiguous upcoming track matched by title or artist. */
export function handleRemove(context: CommandContext, bot: VoiceBot, userClid: number, args: string): void {
  const query = args.trim().toLowerCase();
  if (!query) { context.reply(bot, userClid, 'Usage: !remove <text>'); return; }
  const upcoming = bot.queue.getAll().map((item, index) => ({ item, index }))
    .filter(({ index }) => index > bot.queue.index);
  const exact = upcoming.filter(({ item }) => item.title.toLowerCase() === query || item.artist?.toLowerCase() === query);
  const matches = exact.length ? exact : upcoming.filter(({ item }) =>
    item.title.toLowerCase().includes(query) || item.artist?.toLowerCase().includes(query));
  if (matches.length !== 1) {
    context.reply(bot, userClid, matches.length
      ? 'Multiple matches; use !queue remove <n>: ' + matches.slice(0, 5).map(({ item, index }) => `#${index + 1} ${item.title.slice(0, 60)}`).join(', ')
      : 'No upcoming track matches.');
    return;
  }
  bot.queue.removeAt(matches[0].index);
  context.reply(bot, userClid, `Removed: ${matches[0].item.title.slice(0, 100)}`);
}

/** Format all queued tracks with the current playback index. */
export function showQueue(context: CommandContext, bot: VoiceBot, userClid: number): void {
  const items = bot.queue.getAll();
  const trackLines = items.map((item) => ({
    title: item.title,
    artist: item.artist,
    duration: item.duration,
  }));
  context.reply(
    bot,
    userClid,
    formatQueueMessage(trackLines, bot.queue.index),
  );
}

/** Show, remove, play, clear, or append queue items using chat arguments. */
export async function handleQueue(
  context: CommandContext,
  botId: number,
  bot: VoiceBot,
  userClid: number,
  args: string,
): Promise<void> {
  // No args or "show" — display current queue
  if (!args || args.toLowerCase() === 'show') {
    context.showQueue(bot, userClid);
    return;
  }

  // !queue remove <index>
  if (args.toLowerCase().startsWith('remove ')) {
    const idx = (/^[1-9]\d*$/.test(args.substring(7).trim()) ? Number(args.substring(7).trim()) : NaN) - 1; // 1-based to 0-based
    const items = bot.queue.getAll();
    if (isNaN(idx) || idx < 0 || idx >= items.length) {
      context.reply(bot, userClid, `Invalid index. Queue has ${items.length} tracks.`);
      return;
    }
    const removed = items[idx];
    bot.queue.removeAt(idx);
    context.reply(bot, userClid, `Removed #${idx + 1}: ${removed.title}`);
    return;
  }

  // !queue play <index>
  if (args.toLowerCase().startsWith('play ')) {
    const idx = (/^[1-9]\d*$/.test(args.substring(5).trim()) ? Number(args.substring(5).trim()) : NaN) - 1; // 1-based to 0-based
    const item = bot.queue.playAt(idx);
    if (!item) {
      context.reply(bot, userClid, `Invalid index. Queue has ${bot.queue.length} tracks.`);
      return;
    }
    if (item.streamUrl) {
      await bot.playStream(item, context.chatMusicSwitch(bot));
    } else {
      await bot.play(item, context.chatMusicSwitch(bot));
    }
    context.reply(bot, userClid, `Playing #${idx + 1}: ${item.title}`);
    return;
  }

  // !queue clear
  if (args.toLowerCase() === 'clear') {
    invalidateChatPlaylistExpansion(bot.currentConfig.id);
    bot.queue.clear();
    bot.clearPlayback();
    context.reply(bot, userClid, 'Queue cleared.');
    return;
  }

  // URL provided — add to queue without interrupting
  if (!args.startsWith('http://') && !args.startsWith('https://')) {
    context.reply(bot, userClid, 'Usage: !queue [show|play <n>|remove <n>|clear|<url>]');
    return;
  }

  context.reply(bot, userClid, 'Loading...');

  try {
    await context.enqueueMediaUrl(botId, bot, userClid, args);
  } catch (err: any) {
    context.reply(bot, userClid, `Failed to queue: ${err.message}`);
  }
}

/** Toggle or explicitly set queue shuffling using the accepted chat values. */
export function handleShuffle(context: CommandContext, bot: VoiceBot, userClid: number, args: string): void {
  const arg = args.trim().toLowerCase();
  let enabled: boolean;
  if (!arg) {
    enabled = !bot.queue.shuffle;
  } else if (arg === 'on' || arg === '1' || arg === 'true' || arg === 'yes') {
    enabled = true;
  } else if (arg === 'off' || arg === '0' || arg === 'false' || arg === 'no') {
    enabled = false;
  } else {
    context.reply(bot, userClid, 'Usage: !shuffle [on|off]');
    return;
  }

  bot.queue.setShuffle(enabled);
  context.reply(bot, userClid, enabled ? 'Shuffle on.' : 'Shuffle off.');
}

/** Record a source URL in server-scoped request history without blocking playback. */
export function saveMusicRequest(context: CommandContext, bot: VoiceBot, item: QueueItem): void {
  if (!item.sourceUrl || !bot.currentConfig.serverConfigId) return;
  context.prisma.musicRequest.upsert({
    where: {
      serverConfigId_url: {
        serverConfigId: bot.currentConfig.serverConfigId,
        url: item.sourceUrl,
      },
    },
    update: {
      requestedAt: new Date(),
      title: item.title || 'Unknown Title',
    },
    create: {
      serverConfigId: bot.currentConfig.serverConfigId,
      url: item.sourceUrl,
      title: item.title || 'Unknown Title',
      requestedAt: new Date(),
    },
  }).catch((err) => {
    console.error('[MusicCmd] Failed to save music request history:', err.message);
  });
}
