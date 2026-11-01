import type { VoiceBot } from '../voice-bot.js';
import type { QueueItem } from '../playlist/queue.js';
import { formatRadioListMessage } from '../ts6-chat-format.js';
import type { CommandContext } from './context.js';
import { invalidatePlaylistExpansion } from '../playlist-expansion.js';
import { beginChatMediaRequest, getChatMediaGeneration, invalidateChatPlaylistExpansion } from './queue.js';

// ─── Command Handlers ───────────────────────────────────────
/** List configured radio stations or play a selected station in the requesting channel. */
export async function handleRadio(
  context: CommandContext,
  botId: number,
  bot: VoiceBot,
  userClid: number,
  args: string,
): Promise<void> {
  const generation = getChatMediaGeneration(botId);
  const serverConfigId = bot.currentConfig.serverConfigId;
  const virtualServerId = context.virtualServerIdForBot(botId);
  const isSameBot = () => context.voiceBotManager.getBot(botId) === bot
    && bot.currentConfig.serverConfigId === serverConfigId
    && context.virtualServerIdForBot(botId) === virtualServerId;
  // Get serverConfigId for this bot from DB
  const dbBot = await context.prisma.musicBot.findUnique({ where: { id: botId }, select: { serverConfigId: true } });
  if (!isSameBot()) return;
  if (!dbBot) {
    context.reply(bot, userClid, 'Bot config not found.');
    return;
  }

  const stations = await context.prisma.radioStation.findMany({
    where: { serverConfigId: dbBot.serverConfigId },
    orderBy: { name: 'asc' },
  });
  if (!isSameBot()) return;

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
  const stationId = Number(args);
  if (!/^[1-9]\d*$/.test(args) || !Number.isSafeInteger(stationId)) {
    context.reply(bot, userClid, 'Usage: !radio <id> — Use !radio to list stations.');
    return;
  }

  const station = stations.find((s: any) => s.id === stationId);
  if (!station) {
    context.reply(bot, userClid, `Station #${stationId} not found. Use !radio to list stations.`);
    return;
  }

  if (getChatMediaGeneration(botId) !== generation) return;
  const request = beginChatMediaRequest(botId);
  const isCurrent = () => !request.isCancelled() && isSameBot();
  await context.joinChannelForCommand(botId, bot, userClid);
  if (!isCurrent()) return;

  const queueItem: QueueItem = {
    id: `radio_${station.id}`,
    title: station.name,
    artist: station.genre ?? 'Radio',
    filePath: '',
    source: 'radio',
    streamUrl: station.url,
  };

  await bot.playStream(queueItem, context.chatMusicSwitch(bot));
  if (!isCurrent() || bot.nowPlaying !== queueItem) return;
  context.saveMusicRequest(bot, queueItem);
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
  const request = args ? beginChatMediaRequest(botId) : undefined;
  await context.joinChannelForCommand(botId, bot, userClid);
  if (request?.isCancelled()) return;

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
      const song = await context.findSong(query, request!.signal);
      if (request!.isCancelled()) return;
      if (!song) {
        context.reply(bot, userClid, `No results for "${query}".`);
        return;
      }
      url = song.url;
    } catch (err: any) {
      if (request!.isCancelled()) return;
      context.reply(bot, userClid, `Search failed: ${err.message}`);
      return;
    }
  } else {
    context.reply(bot, userClid, 'Loading...');
  }

  try {
    await context.enqueueMediaUrl(botId, bot, userClid, url, request);
  } catch (err: any) {
    if (request?.isCancelled()) return;
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

export type PauseResult = 'paused' | 'already_paused' | 'idle';
export type ResumeResult = 'resumed' | 'already_playing' | 'idle';
export type SkipResult = { kind: 'skipped'; title: string } | { kind: 'empty' };

/** Explicit pause. Already-paused is a no-op success. Chat `!pause` stays a toggle. */
export function pausePlayback(bot: VoiceBot): PauseResult {
  if (bot.status === 'paused') return 'already_paused';
  if (bot.status === 'playing') {
    bot.pause();
    return 'paused';
  }
  return 'idle';
}

/** Explicit resume. Already-playing is a no-op success. */
export function resumePlayback(bot: VoiceBot): ResumeResult {
  if (bot.status === 'playing') return 'already_playing';
  if (bot.status === 'paused') {
    bot.resume();
    return 'resumed';
  }
  return 'idle';
}

/**
 * Cancel chat + HTTP playlist expansions and stop audio. Music stop clears the
 * queue; radio keeps it, since Up next is kept while radio plays.
 */
export function stopPlayback(bot: VoiceBot): void {
  const botId = bot.currentConfig.id;
  invalidateChatPlaylistExpansion(botId);
  invalidatePlaylistExpansion(botId);
  if (!bot.isStreaming) bot.queue.clear();
  bot.stopAudio();
}

export function handleStop(context: CommandContext, bot: VoiceBot, userClid: number): void {
  stopPlayback(bot);
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
export async function skipPlayback(
  bot: VoiceBot,
  musicSwitch?: { replaceSessionIds: string[] },
): Promise<SkipResult> {
  const next = bot.queue.next();
  if (next) {
    if (next.streamUrl) await bot.playStream(next, musicSwitch);
    else await bot.play(next, musicSwitch);
    return { kind: 'skipped', title: next.title };
  }
  // A skip is not a Stop: requests still loading are kept.
  bot.stopAudio({ keepPendingRequests: true });
  return { kind: 'empty' };
}

export async function handleSkip(context: CommandContext, bot: VoiceBot, userClid: number): Promise<void> {
  const result = await skipPlayback(bot, context.chatMusicSwitch(bot));
  if (result.kind === 'skipped') {
    context.reply(bot, userClid, `Skipped to: ${result.title}`);
    return;
  }
  context.reply(bot, userClid, 'Queue empty — playback stopped.');
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

/** Shared 0–100 volume parse for TeamSpeak `!vol` and Discord `/volume`. */
export function parseVolumeLevel(raw: string): number | null {
  const vol = parseInt(raw, 10);
  if (Number.isNaN(vol) || vol < 0 || vol > 100) return null;
  return vol;
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

  const vol = parseVolumeLevel(args);
  if (vol == null) {
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
