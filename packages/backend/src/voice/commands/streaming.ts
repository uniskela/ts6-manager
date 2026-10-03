import { loadIptvLocalHosts } from '../../utils/app-settings.js';
import { recordIptvRecentSafely } from '../../iptv/iptv-picks.js';
import type { VoiceBot } from '../voice-bot.js';
import { MediaSessionConflictError } from '../media-session.js';
import { parseStreamStartOptions } from '../streaming/start-options.js';
import { classifyStreamHost } from '../streaming/video-download.js';
import type { CommandContext } from './context.js';

// ─── Video Streaming Commands ─────────────────────────────
/** Validate stream arguments and start or change a video source with existing preset rules. */
export async function handleStream(
  context: CommandContext,
  bot: VoiceBot,
  userClid: number,
  args: string,
): Promise<void> {
  if (!args) {
    context.reply(bot, userClid, 'Usage: !stream <url> [preset]  — Presets: auto (default for YouTube and Twitch), 480p, 720p, 1080p, 1440p, 2160p');
    return;
  }

  const parts = args.split(/\s+/);
  const url = parts[0];
  // No preset means Auto for YouTube and Twitch links: the largest preset the
  // source fills, up to the Auto quality limit, as the web UI starts a
  // stream. Left undefined, the start falls back to the bot's stored preset,
  // which no UI can change from 720p, so a 4K video came out at 720p whatever
  // Streaming defaults said.
  // Any other URL keeps that fixed fallback, as !tv does: it is passed
  // straight to FFmpeg and may be an IPTV link, and Auto probes it first,
  // which is a second connection some IPTV services do not allow. (A YouTube
  // download is probed on disk.) Typing `auto` still asks for Auto.
  const preset = parts[1] || (classifyStreamHost(url) === 'other' ? undefined : 'auto');

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    context.reply(bot, userClid, 'Please provide a valid URL.');
    return;
  }

  if (preset) {
    const parsed = parseStreamStartOptions({ preset });
    if (!parsed.ok) {
      context.reply(bot, userClid, parsed.error);
      return;
    }
  }

  if (bot.videoStreaming) {
    // Change source if already streaming
    try {
      await bot.setVideoSource(url);
      context.reply(bot, userClid, `Stream source changed to: ${url}`);
    } catch (err: any) {
      context.reply(bot, userClid, `Error: ${err.message}`);
    }
    return;
  }

  context.reply(bot, userClid, 'Starting video stream...');
  try {
    await context.voiceBotManager.startVideoStream(bot, url, { preset, ...context.chatVideoSwitch(bot) });
    context.reply(bot, userClid, `Video stream started: ${url}`);
  } catch (err: any) {
    context.reply(bot, userClid, `Failed to start stream: ${context.streamStartError(err)}`);
  }
}

/** Format stream conflicts with another bot while retaining other error messages. */
export function streamStartError(context: CommandContext, err: any): string {
  if (err instanceof MediaSessionConflictError) {
    const other = err.conflicts.find((c) => c.kind === 'video');
    if (other) return `another stream is running on ${other.botName} — stop it there first`;
  }
  return err?.message ?? String(err);
}

/** Stop an active video stream with the existing manual stop reason. */
export async function handleStopStream(
  context: CommandContext,
  bot: VoiceBot,
  userClid: number,
): Promise<void> {
  if (!bot.videoStreaming) {
    context.reply(bot, userClid, 'No active video stream.');
    return;
  }
  await bot.stopVideoStream('manual', 'Stopped by chat command');
  context.reply(bot, userClid, 'Video stream stopped.');
}

/** List the first matching IPTV channels belonging to the bot’s server. */
export async function handleChannels(
  context: CommandContext,
  bot: VoiceBot,
  userClid: number,
  args: string,
): Promise<void> {
  const serverConfigId = bot.currentConfig.serverConfigId;
  if (!serverConfigId) {
    context.reply(bot, userClid, 'No server configured for this bot.');
    return;
  }
  const search = args.trim();
  const channels = await context.prisma.iptvChannel.findMany({
    where: {
      playlist: { serverConfigId },
      ...(search ? { name: { contains: search } } : {}),
    },
    orderBy: { position: 'asc' },
    take: 20,
  });

  if (channels.length === 0) {
    context.reply(bot, userClid, search
      ? `No IPTV channels matching "${search}". Add a playlist in the IPTV page.`
      : 'No IPTV channels found. Add a playlist in the IPTV page.');
    return;
  }

  const list = channels.map((c) => `• ${c.name}`).join('\n');
  context.reply(
    bot,
    userClid,
    `IPTV channels${search ? ` matching "${search}"` : ''} (first ${channels.length}):\n${list}\n\nUse !tv <name> to stream one.`,
  );
}

/** Start or switch to a server-scoped IPTV channel and record successful recent playback. */
export async function handleTv(
  context: CommandContext,
  bot: VoiceBot,
  userClid: number,
  args: string,
): Promise<void> {
  const query = args.trim();
  if (!query) {
    context.reply(bot, userClid, 'Usage: !tv <channel name>  — Use !channels to list.');
    return;
  }
  const serverConfigId = bot.currentConfig.serverConfigId;
  if (!serverConfigId) {
    context.reply(bot, userClid, 'No server configured for this bot.');
    return;
  }

  const channel = await context.prisma.iptvChannel.findFirst({
    where: { playlist: { serverConfigId }, name: { contains: query } },
    orderBy: { position: 'asc' },
  });
  if (!channel) {
    context.reply(bot, userClid, `No channel matching "${query}". Use !channels ${query} to search.`);
    return;
  }

  if (bot.videoStreaming) {
    await bot.setVideoSource(channel.url, undefined, 'live', await loadIptvLocalHosts(context.prisma));
    await recordIptvRecentSafely(context.prisma, serverConfigId, channel);
    context.reply(bot, userClid, `Now streaming: ${channel.name}`);
    return;
  }

  context.reply(bot, userClid, `Starting stream: ${channel.name}...`);
  try {
    await context.voiceBotManager.startVideoStream(bot, channel.url, {
      sourceMode: 'live',
      // The channel URL comes from an admin playlist; users only pick a name.
      localHosts: await loadIptvLocalHosts(context.prisma),
      ...context.chatVideoSwitch(bot),
    });
    await recordIptvRecentSafely(context.prisma, serverConfigId, channel);
    context.reply(bot, userClid, `Video stream started: ${channel.name}`);
  } catch (err: any) {
    context.reply(bot, userClid, `Failed to start stream: ${context.streamStartError(err)}`);
  }
}
