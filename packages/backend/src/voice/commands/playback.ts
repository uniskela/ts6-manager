import type { VoiceBot } from '../voice-bot.js';
import type { QueueItem } from '../playlist/queue.js';
import { formatRadioListMessage } from '../ts6-chat-format.js';
import type { CommandContext } from './context.js';
import { invalidatePlaylistExpansion } from '../playlist-expansion.js';
import { invalidateChatPlaylistExpansion } from './queue.js';

// ─── Command Handlers ───────────────────────────────────────
/** List configured radio stations or play a selected station in the requesting channel. */
export async function handleRadio(
  context: CommandContext,
  botId: number,
  bot: VoiceBot,
  userClid: number,
  args: string,
): Promise<void> {
  // Get serverConfigId for this bot from DB
  const dbBot = await context.prisma.musicBot.findUnique({ where: { id: botId }, select: { serverConfigId: true } });
  if (!dbBot) {
    context.reply(bot, userClid, 'Bot config not found.');
    return;
  }

  const stations = await context.prisma.radioStation.findMany({
    where: { serverConfigId: dbBot.serverConfigId },
    orderBy: { name: 'asc' },
  });

  if (stations.length === 0) {
    context.reply(bot, userClid, 'No radio stations configured.');
    return;
  }

  // No argument — list stations
  if (!args) {
    context.reply(
      bot,
      userClid,
      formatRadioListMessage(
        stations.map((s: any) => ({ id: s.id, name: s.name, genre: s.genre })),
      ),
    );
    return;
  }

  // Argument — play station by ID
  const stationId = parseInt(args);
  if (isNaN(stationId)) {
    context.reply(bot, userClid, 'Usage: !radio <id> — Use !radio to list stations.');
    return;
  }

  const station = stations.find((s: any) => s.id === stationId);
  if (!station) {
    context.reply(bot, userClid, `Station #${stationId} not found. Use !radio to list stations.`);
    return;
  }

  await context.joinChannelForCommand(botId, bot, userClid);

  const queueItem: QueueItem = {
    id: `radio_${station.id}`,
    title: station.name,
    artist: station.genre ?? 'Radio',
    filePath: '',
    source: 'radio',
    streamUrl: station.url,
  };

  await bot.playStream(queueItem, context.chatMusicSwitch(bot));
  context.reply(bot, userClid, `Now playing: ${station.name}`);
}

/** Longest free-text query `!play <song name>` sends to search. */
const MAX_SONG_QUERY_LENGTH = 200;

/** Resume paused playback, or resolve a media URL or song search into the queue. */
export async function handlePlay(
  context: CommandContext,
  botId: number,
  bot: VoiceBot,
  userClid: number,
  args: string,
): Promise<void> {
  await context.joinChannelForCommand(botId, bot, userClid);

  if (!args) {
    if (bot.status === 'paused') {
      bot.resume();
      context.reply(bot, userClid, 'Resumed.');
      return;
    }
    context.reply(bot, userClid, 'Usage: !play <url|song name>');
    return;
  }

  let url = args;
  if (!/^https?:\/\//i.test(args)) {
    const query = args.trim().slice(0, MAX_SONG_QUERY_LENGTH);
    context.reply(bot, userClid, `Searching YouTube Music for "${query}"...`);
    try {
      const song = await context.findSong(query);
      if (!song) {
        context.reply(bot, userClid, `No results for "${query}".`);
        return;
      }
      url = song.url;
    } catch (err: any) {
      context.reply(bot, userClid, `Search failed: ${err.message}`);
      return;
    }
  } else {
    context.reply(bot, userClid, 'Loading...');
  }

  try {
    await context.enqueueMediaUrl(botId, bot, userClid, url);
  } catch (err: any) {
    context.reply(bot, userClid, `Failed to play: ${err.message}`);
  }
}

/** Validate absolute or relative seek input and clamp it to the current track. */
export async function handleSeek(
  context: CommandContext,
  bot: VoiceBot,
  userClid: number,
  args: string,
): Promise<void> {
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(args) || !Number.isFinite(Number(args))) {
    context.reply(bot, userClid, 'Usage: !seek <seconds|+seconds|-seconds>'); return;
  }
  if (!bot.canSeek) {
    context.reply(bot, userClid, 'Current source cannot be seeked. Play a local/downloaded track first.'); return;
  }
  const progress = bot.playbackProgress;
  const relative = /^[+-]/.test(args);
  const target = Math.max(0, Math.min((relative ? (progress?.position ?? 0) : 0) + Number(args),
    progress?.duration || bot.nowPlaying?.duration || Infinity));
  try {
    await bot.seek(target);
  } catch {
    context.reply(bot, userClid, 'Could not seek — playback stopped.');
    return;
  }
  context.reply(bot, userClid, `Seeked to ${Math.floor(target)} seconds.`);
}

/**
 * Cancel chat + HTTP playlist expansions and stop audio. Music stop clears the
 * queue; radio keeps it, since Up next is kept while radio plays.
 */
export function handleStop(context: CommandContext, bot: VoiceBot, userClid: number): void {
  const botId = bot.currentConfig.id;
  invalidateChatPlaylistExpansion(botId);
  invalidatePlaylistExpansion(botId);
  if (!bot.isStreaming) bot.queue.clear();
  bot.stopAudio();
  context.reply(bot, userClid, 'Playback stopped.');
}

/** Toggle playing or paused audio and report when there is nothing to pause. */
export function handlePause(context: CommandContext, bot: VoiceBot, userClid: number): void {
  if (bot.status === 'paused') {
    bot.resume();
    context.reply(bot, userClid, 'Resumed.');
  } else if (bot.status === 'playing') {
    bot.pause();
    context.reply(bot, userClid, 'Paused.');
  } else {
    context.reply(bot, userClid, 'Nothing is playing.');
  }
}

/** Play the next queued item or stop audio when the queue is exhausted. */
export async function handleSkip(context: CommandContext, bot: VoiceBot, userClid: number): Promise<void> {
  const next = bot.queue.next();
  if (next) {
    if (next.streamUrl) {
      await bot.playStream(next, context.chatMusicSwitch(bot));
    } else {
      await bot.play(next, context.chatMusicSwitch(bot));
    }
    context.reply(bot, userClid, `Skipped to: ${next.title}`);
  } else {
    bot.stopAudio();
    context.reply(bot, userClid, 'Queue empty — playback stopped.');
  }
}

/** Play the previous queued item or report that no earlier track exists. */
export async function handlePrev(context: CommandContext, bot: VoiceBot, userClid: number): Promise<void> {
  const prev = bot.queue.previous();
  if (prev) {
    if (prev.streamUrl) {
      await bot.playStream(prev, context.chatMusicSwitch(bot));
    } else {
      await bot.play(prev, context.chatMusicSwitch(bot));
    }
    context.reply(bot, userClid, `Previous: ${prev.title}`);
  } else {
    context.reply(bot, userClid, 'No previous track.');
  }
}

/** Report or change the shared bot volume using the existing input validation. */
export async function handleVolume(
  context: CommandContext,
  bot: VoiceBot,
  userClid: number,
  args: string,
): Promise<void> {
  if (!args) {
    const vol = bot.currentConfig.volume;
    context.reply(bot, userClid, `Volume: ${vol}%`);
    return;
  }

  const vol = parseInt(args);
  if (isNaN(vol) || vol < 0 || vol > 100) {
    context.reply(bot, userClid, 'Usage: !vol <0-100>');
    return;
  }

  try {
    // One level for music, radio, video, and IPTV. applyVolume pushes it
    // into a running sidecar stream; music reads config.volume each frame.
    await bot.applyVolume(vol);
    context.reply(bot, userClid, `Volume set to ${bot.currentConfig.volume}%.`);
  } catch (err: any) {
    context.reply(bot, userClid, `Could not set volume: ${err?.message ?? err}`);
  }
}
