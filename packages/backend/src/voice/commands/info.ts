import type { VoiceBot } from '../voice-bot.js';
import { fetchLyrics, chunkLyrics, lyricsInputFromTrack } from '../lyrics.js';
import { BUILTIN_COMMAND_HELP } from '../chat-commands.js';
import { formatCustomCommandsMessage, formatHelpMessage, formatNowPlayingMessage } from '../ts6-chat-format.js';
import type { CommandContext } from './context.js';
import { tryClaimChatInfoReply, helpActionKey, beginHelpAction, completeHelpAction } from './dedupe.js';

/** List enabled custom replies after claiming the server, channel, and user cooldown. */
export async function handleCustomCommandsList(
  context: CommandContext,
  botId: number,
  bot: VoiceBot,
  userClid: number,
): Promise<void> {
  const dbBot = await context.prisma.musicBot.findUnique({
    where: { id: botId },
    select: { serverConfigId: true },
  });
  if (!dbBot) return;
  const channelId = context.replyChannelForDedupe(botId, userClid, bot);
  const sid = context.virtualServerIdForBot(botId);
  if (!tryClaimChatInfoReply(dbBot.serverConfigId, sid, channelId, userClid, 'commands')) return;
  const custom = await context.prisma.chatCommand.findMany({
    where: { serverConfigId: dbBot.serverConfigId, enabled: true },
    orderBy: { name: 'asc' },
    select: { name: true, description: true },
  });
  await context.reply(bot, userClid, formatCustomCommandsMessage(custom));
}

/** Claim a shared help flight and reply with built-in and enabled custom commands. */
export async function handleHelp(
  context: CommandContext,
  botId: number,
  bot: VoiceBot,
  userClid: number,
): Promise<void> {
  const cfg = context.botChannelConfig.get(botId);
  const serverConfigId = cfg?.serverConfigId ?? bot.currentConfig.serverConfigId;
  const virtualServerId = cfg?.virtualServerId ?? 1;
  const hinted =
    context.activeReplyChannel.get(`${botId}:${userClid}`) ||
    bot.getCurrentChannelId() ||
    0;

  // When the channel is already known, join the wait-for-owner flight before any
  // await so we either own the post or wait for SSH / another bot's outcome.
  let ownedKey: string | null = null;
  if (hinted > 0) {
    ownedKey = helpActionKey(serverConfigId, virtualServerId, hinted, userClid);
    if (!(await beginHelpAction(ownedKey))) {
      console.log(
        `[MusicCmd] !help deduped (bot=${botId} cid=${hinted} clid=${userClid})`,
      );
      return;
    }
  }

  const channelId = await context.resolveCommandChannelId(
    botId,
    bot,
    userClid,
    hinted > 0 ? hinted : undefined,
  );

  if (channelId > 0) {
    context.activeReplyChannel.set(`${botId}:${userClid}`, channelId);
  }

  // Do not own with cid=0 — that key never matches the SSH helper's parked
  // cid, so voice + cross-channel both post. Align with !here: resolve first; if
  // still unknown, only leave it to SSH when the main helper is parked there
  // (main SSH connected ≠ helper will answer after empty-commandChannelIds).
  if (channelId <= 0) {
    if (ownedKey) completeHelpAction(ownedKey, false);
    console.warn(
      `[MusicCmd] !help skipped on voice bot=${botId}: unknown channel (homeCid=${bot.getCurrentChannelId()})`,
    );
    if (context.sshHelperOwnsChannel(serverConfigId, virtualServerId, channelId)) return;
    // Pure voice, SSH down, or helper not parked for this channel: own cid=0.
  }

  const helpKey = helpActionKey(
    serverConfigId,
    virtualServerId,
    channelId > 0 ? channelId : 0,
    userClid,
  );
  if (ownedKey && ownedKey !== helpKey) {
    completeHelpAction(ownedKey, false);
    ownedKey = null;
  }
  if (!ownedKey) {
    if (!(await beginHelpAction(helpKey))) {
      console.log(
        `[MusicCmd] !help deduped (bot=${botId} cid=${channelId || 0} clid=${userClid})`,
      );
      return;
    }
    ownedKey = helpKey;
  }

  try {
    const dbBot = await context.prisma.musicBot.findUnique({
      where: { id: botId },
      select: { serverConfigId: true },
    });

    let custom: Array<{ name: string; description: string | null }> = [];
    if (dbBot) {
      custom = await context.prisma.chatCommand.findMany({
        where: { serverConfigId: dbBot.serverConfigId, enabled: true },
        orderBy: { name: 'asc' },
        select: { name: true, description: true },
      });
    }

    await context.reply(bot, userClid, formatHelpMessage(BUILTIN_COMMAND_HELP, custom));
    completeHelpAction(ownedKey, true);
  } catch (err) {
    completeHelpAction(ownedKey, false);
    throw err;
  }
}

/**
 * Cross-channel !help when no music bot is in the requester channel.
 * Posts via SSH Query as "TS6 Helper" (brief channel presence) — not a full voice bot.
 */
export async function handleHelpCrossChannel(
  context: CommandContext,
  configId: number,
  sid: number,
  channelId: number,
  data: Record<string, string>,
): Promise<void> {
  const userClid = parseInt(data.invokerid || '0', 10);
  if (!userClid || channelId <= 0) return;

  const helpKey = helpActionKey(configId, sid, channelId, userClid);
  // Own immediately so concurrent voice waits on our result instead of bailing.
  // completeHelpAction(false) lets that waiter become owner and still reply.
  if (!(await beginHelpAction(helpKey))) {
    console.log(
      `[MusicCmd] Cross-channel !help deduped (cid=${channelId} clid=${userClid})`,
    );
    return;
  }

  let posted = false;
  try {
    console.log(
      `[MusicCmd] Cross-channel !help (config=${configId} sid=${sid} cid=${channelId} clid=${userClid})`,
    );

    let custom: Array<{ name: string; description: string | null }> = [];
    try {
      custom = await context.prisma.chatCommand.findMany({
        where: { serverConfigId: configId, enabled: true },
        orderBy: { name: 'asc' },
        select: { name: true, description: true },
      });
    } catch (err: any) {
      console.warn(`[MusicCmd] !help custom command lookup failed: ${err.message}`);
    }

    const msg = formatHelpMessage(BUILTIN_COMMAND_HELP, custom);
    if (!context.eventBridge) {
      console.warn(`[MusicCmd] Cross-channel !help: no eventBridge (cid=${channelId})`);
      return;
    }
    const ok = await context.eventBridge.sendChannelText(configId, sid, channelId, msg, {
      helperNickname: 'TS6 Helper',
    });
    if (!ok) {
      console.warn(
        `[MusicCmd] Cross-channel !help failed to post in cid=${channelId} (SSH listener?)`,
      );
      return;
    }
    posted = true;
  } catch (err: any) {
    console.warn(
      `[MusicCmd] Cross-channel !help threw for cid=${channelId}: ${err?.message || err}`,
    );
  } finally {
    // Always settle so waiters are not stuck if sendChannelText throws.
    completeHelpAction(helpKey, posted);
  }
}

/** Look up an enabled server-scoped custom command and apply its reply cooldown. */
export async function handleCustomCommand(
  context: CommandContext,
  botId: number,
  bot: VoiceBot,
  userClid: number,
  command: string,
): Promise<void> {
  const dbBot = await context.prisma.musicBot.findUnique({
    where: { id: botId },
    select: { serverConfigId: true },
  });
  if (!dbBot) return;

  const custom = await context.prisma.chatCommand.findUnique({
    where: {
      serverConfigId_name: { serverConfigId: dbBot.serverConfigId, name: command },
    },
  });
  if (!custom || !custom.enabled) return;

  const channelId = context.replyChannelForDedupe(botId, userClid, bot);
  const sid = context.virtualServerIdForBot(botId);
  if (!tryClaimChatInfoReply(dbBot.serverConfigId, sid, channelId, userClid, command)) return;
  console.log(`[MusicCmd] Bot ${botId}: !${command} (custom, from clid=${userClid})`);
  await context.reply(bot, userClid, custom.response);
}

/** Format current playback progress, queue context, and available controls. */
export function handleNowPlaying(context: CommandContext, bot: VoiceBot, userClid: number): void {
  const np = bot.nowPlaying;
  if (!np) {
    context.reply(bot, userClid, '_Nothing is playing._');
    return;
  }

  const progress = bot.playbackProgress;
  const upcoming = bot.queue.upcoming(5).map((item) => ({
    title: item.title,
    artist: item.artist,
    duration: item.duration,
  }));

  context.reply(
    bot,
    userClid,
    formatNowPlayingMessage({
      title: np.title,
      artist: np.artist,
      position: progress?.position,
      duration: progress?.duration ?? np.duration,
      paused: bot.status === 'paused',
      upcoming,
      totalQueueLength: bot.queue.length,
      queueIndex: bot.queue.index,
      includeControls: true,
    }),
  );
}

/** Fetch lyrics for a supplied query or the current track and send bounded chunks. */
export async function handleLyrics(
  context: CommandContext,
  bot: VoiceBot,
  userClid: number,
  args: string,
): Promise<void> {
  let input: { artist?: string; title?: string; query?: string };
  let label: string;

  if (args.trim()) {
    input = { query: args.trim() };
    label = args.trim();
  } else {
    const np = bot.nowPlaying;
    if (!np) {
      context.reply(bot, userClid, 'Nothing playing. Usage: !lyrics [artist - title]');
      return;
    }
    const parsed = lyricsInputFromTrack({ artist: np.artist, title: np.title });
    input = parsed.input;
    label = parsed.label;
  }

  context.reply(bot, userClid, 'Looking up lyrics…');
  const result = await fetchLyrics(input);
  if (!result) {
    context.reply(bot, userClid, `Lyrics not found for "${label}".`);
    return;
  }
  if (result.instrumental) {
    context.reply(bot, userClid, `♪ ${result.artist} — ${result.title}: instrumental track.`);
    return;
  }

  const header = `🎤 ${result.artist ? `${result.artist} — ` : ''}${result.title}`;
  for (const chunk of chunkLyrics(header, result.lyrics, 900)) {
    context.reply(bot, userClid, chunk);
  }
}

/** Show current stream viewers and how long each viewer has been connected. */
export function handleViewers(context: CommandContext, bot: VoiceBot, userClid: number): void {
  const status = bot.videoStreamStatus;
  if (!status.streaming) {
    context.reply(bot, userClid, 'No active video stream.');
    return;
  }
  if (status.viewers.length === 0) {
    context.reply(bot, userClid, 'No viewers connected.');
    return;
  }
  const lines = status.viewers.map((v) => {
    const duration = Math.floor((Date.now() - v.joinedAt) / 1000);
    return `  clid=${v.clid} (${duration}s)`;
  });
  context.reply(bot, userClid, `Viewers (${status.viewerCount}):\n${lines.join('\n')}`);
}
