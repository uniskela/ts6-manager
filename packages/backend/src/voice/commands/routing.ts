import type { VoiceBot } from '../voice-bot.js';
import { BUILTIN_CHAT_COMMANDS } from '../chat-commands.js';
import type { EventBridge } from '../../bot-engine/event-bridge.js';
import { channelListenerKey } from '../music-command-channels.js';
import type { CommandContext } from './context.js';
import { isBotSummonable } from './channel-ownership.js';
const CMD_PREFIX = '!';
const MUSIC_COMMANDS = new Set<string>(BUILTIN_CHAT_COMMANDS);

export function setEventBridge(context: CommandContext, bridge: EventBridge): void {
  context.eventBridge = bridge;
  if (!context.eventBridgeListening) {
    context.eventBridgeListening = true;
    bridge.on('tsEvent', (configId, sid, eventName, data) => {
      // Park the main SSH helper in the human's channel (no second Query login).
      // Never follow a music voice bot — that abandons cross-channel humans.
      if (
        (eventName === 'notifycliententerview' || eventName === 'notifyclientmoved') &&
        !data.__cmd_listener_channel_id
      ) {
        const cid = parseInt(
          data.ctid || data.cid || data.client_channel_id || '0',
          10,
        );
        const clid = parseInt(data.clid || '0', 10);
        if (cid > 0 && String(data.client_type || '0') !== '1') {
          if (clid > 0 && context.musicBotClidsOnServer(configId, sid).has(clid)) {
            context.scheduleMainHelperRebalance(configId, sid);
          } else {
            context.scheduleMainHelperPark(configId, sid, cid);
          }
        }
      }
      if (eventName !== 'notifytextmessage') return;

      // Prefer legacy per-channel CMD markers when BotEngine flows still use them.
      let channelId = parseInt(data.__cmd_listener_channel_id || '0', 10);
      if (channelId <= 0) {
        // Main SSH roaming helper — hears chat only in its parked channel.
        channelId = bridge.getMainHelperChannelId(configId, sid);
      }
      if (channelId <= 0) {
        channelId = parseInt(
          data.target || data.invokerchannelid || data.cid || '0',
          10,
        );
      }
      if (channelId <= 0) {
        const preview = (data.msg || '').slice(0, 40);
        console.log(
          `[MusicCmd] SSH textmessage ignored (no helper channel) ` +
            `(config=${configId} sid=${sid} msg=${JSON.stringify(preview)})`,
        );
        return;
      }
      console.log(
        `[MusicCmd] SSH textmessage config=${configId} sid=${sid} ` +
          `cid=${channelId} clid=${data.invokerid || '?'} msg=${JSON.stringify((data.msg || '').slice(0, 60))}`,
      );
      context.onCrossChannelTextMessage(configId, sid, channelId, data).catch(
        (err) => {
          console.error(`[MusicCmd] Cross-channel message error: ${err.message}`);
        },
      );
    });
  }
  void context.syncMusicSessionOwnership();
}

/**
 * Register text message listener on a VoiceBot instance.
 * Called by VoiceBotManager whenever a bot is created/started.
 */
export function registerBot(context: CommandContext, botId: number, bot: VoiceBot): void {
  if (context.registeredBots.has(botId)) {
    console.log(`[MusicCmd] Bot ${botId} already registered for text commands`);
    return;
  }
  context.registeredBots.add(botId);

  bot.on('textMessage', (data: Record<string, string>) => {
    void (async () => {
      let replyCid = bot.getCurrentChannelId();
      if (replyCid <= 0) {
        const hinted = parseInt(
          data.invokerchannelid || data.ctid || data.cid || data.target || '0',
          10,
        );
        if (hinted > 0) {
          replyCid = hinted;
          if (typeof bot.setCurrentChannelIdIfUnknown === 'function') {
            bot.setCurrentChannelIdIfUnknown(hinted);
          }
        } else if (typeof bot.ensureHomeChannelDiscovered === 'function') {
          // Same-channel chat proves presence — learn cid via voice socket, not SSH.
          replyCid = await bot.ensureHomeChannelDiscovered();
        }
      }
      console.log(
        `[MusicCmd] Voice textmessage bot=${botId} clid=${data.invokerid || '?'} ` +
          `homeCid=${bot.getCurrentChannelId()} replyCid=${replyCid || 0} ` +
          `msg=${JSON.stringify((data.msg || '').slice(0, 60))}`,
      );
      await context.onTextMessage(
        botId,
        bot,
        data,
        replyCid > 0 ? replyCid : undefined,
      );
    })().catch((err) => {
      console.error(
        `[MusicCmd] Error processing text message on bot ${botId}: ${err.message}`,
      );
    });
  });

  void context.refreshBotChannels(botId);

  console.log(`[MusicCmd] Registered text command listener on bot ${botId}`);
}

export async function onCrossChannelTextMessage(
  context: CommandContext,
  configId: number,
  sid: number,
  channelId: number,
  data: Record<string, string>,
): Promise<void> {
  const key = channelListenerKey(configId, sid, channelId);
  let botIds = context.channelToBots.get(key);
  if (!botIds || botIds.size === 0) {
    // Empty commandChannelIds / pre-map race: fall back to every bot on this pair.
    const fallback = new Set<number>();
    for (const [botId, cfg] of context.botChannelConfig) {
      if (cfg.serverConfigId === configId && cfg.virtualServerId === sid) {
        fallback.add(botId);
      }
    }
    if (fallback.size === 0) {
      console.warn(
        `[MusicCmd] Cross-channel text in cid=${channelId} but no bots mapped ` +
          `(config=${configId} sid=${sid}); msg=${JSON.stringify((data.msg || '').slice(0, 40))}`,
      );
      return;
    }
    botIds = fallback;
  }

  const msg = (data.msg || '').trim();
  if (msg.startsWith(CMD_PREFIX)) {
    const parts = msg.substring(CMD_PREFIX.length).split(/\s+/);
    const command = (parts[0] || '').toLowerCase();
    if (command === 'here' || command === 'come') {
      // Prefer the in-channel voice path when a music bot is already here —
      // otherwise SSH + voice both announce/join for the same chat line.
      const voiceBotInChannel = [...botIds].some((id) => {
        const bot = context.voiceBotManager.getBot(id);
        return (
          !!bot &&
          isBotSummonable(bot) &&
          bot.getCurrentChannelId() === channelId
        );
      });
      if (voiceBotInChannel) {
        console.log(
          `[MusicCmd] Cross-channel !here skipped: voice bot already in cid=${channelId}`,
        );
        return;
      }
      const rawArgs = parts.slice(1).join(' ').trim();
      await context.handleHereCrossChannel(configId, sid, channelId, data, rawArgs);
      return;
    }
    if (command === 'help') {
      const voiceBotInChannel = [...botIds].some((id) => {
        const bot = context.voiceBotManager.getBot(id);
        return (
          !!bot &&
          isBotSummonable(bot) &&
          bot.getCurrentChannelId() === channelId
        );
      });
      if (voiceBotInChannel) {
        console.log(
          `[MusicCmd] Cross-channel !help skipped: voice bot already in cid=${channelId}`,
        );
        return;
      }
      await context.handleHelpCrossChannel(configId, sid, channelId, data);
      return;
    }
  }

  const botId = [...botIds].find((id) => {
    const bot = context.voiceBotManager.getBot(id);
    if (!bot || bot.status === 'stopped' || bot.status === 'error') return false;
    // Only skip SSH routing when the voice client is *actually* in this channel.
    const homeCid = bot.getCurrentChannelId();
    if (homeCid > 0 && channelId === homeCid) return false;
    return true;
  });
  if (!botId) {
    console.log(
      `[MusicCmd] Cross-channel text cid=${channelId} ignored: all mapped bots are home or stopped`,
    );
    return;
  }

  const bot = context.voiceBotManager.getBot(botId)!;
  await context.onTextMessage(botId, bot, data, channelId);
}

export async function onTextMessage(
  context: CommandContext,
  botId: number,
  bot: VoiceBot,
  data: Record<string, string>,
  replyChannelId?: number,
): Promise<void> {
  const userClid = parseInt(data.invokerid || '0');
  if (!userClid) return;

  const msg = (data.msg || '').trim();
  if (!msg.startsWith(CMD_PREFIX)) return;
  // During TeamSpeak's anti-flood block every action and reply would be
  // refused and extend the block: set the command aside (the bot says once
  // afterwards that commands were ignored).
  if (bot.floodHoldActive) {
    bot.noteIgnoredCommand();
    return;
  }

  const parts = msg.substring(CMD_PREFIX.length).split(/\s+/);
  const command = parts[0].toLowerCase();
  const rawArgs = parts.slice(1).join(' ').trim();

  const parsedChannelId = parseInt(
    data.target || data.invokerchannelid || data.cid || '0',
    10,
  );
  const commandChannelId =
    replyChannelId ?? (parsedChannelId > 0 ? parsedChannelId : undefined);
  if (commandChannelId && commandChannelId > 0) {
    context.activeReplyChannel.set(`${botId}:${userClid}`, commandChannelId);
  }

  try {

  // TS clients auto-wrap URLs in BBCode: [URL]https://...[/URL]
  const args = rawArgs
    .replace(/\[URL(?:=[^\]]*)?\](.*?)\[\/URL\]/gi, '$1')
    .trim();

  // Ignore messages from ourselves (the bot)
  if (userClid === bot.ts3ClientId) return;

  // Built-in commands
  if (MUSIC_COMMANDS.has(command)) {
    console.log(`[MusicCmd] Bot ${botId}: !${command} ${args} (from clid=${userClid})`);
    try {
      switch (command) {
        case 'help':
          await context.handleHelp(botId, bot, userClid);
          break;
        case 'commands':
          await context.handleCustomCommandsList(botId, bot, userClid);
          break;
        case 'here':
        case 'come':
          await context.handleHere(botId, bot, userClid, args);
          break;
        case 'playlist':
        case 'pl':
          await context.handlePlaylist(botId, bot, userClid, args);
          break;
        case 'repeat':
          context.handleRepeat(bot, userClid, args);
          break;
        case 'seek':
          await context.handleSeek(bot, userClid, args);
          break;
        case 'remove':
          context.handleRemove(bot, userClid, args);
          break;
        case 'radio':
          await context.handleRadio(botId, bot, userClid, args);
          break;
        case 'play':
          await context.handlePlay(botId, bot, userClid, args);
          break;
        case 'stop':
          context.handleStop(bot, userClid);
          break;
        case 'pause':
          context.handlePause(bot, userClid);
          break;
        case 'skip':
        case 'next':
          await context.handleSkip(bot, userClid);
          break;
        case 'prev':
          await context.handlePrev(bot, userClid);
          break;
        case 'vol':
        case 'volume':
          await context.handleVolume(bot, userClid, args);
          break;
        case 'np':
        case 'nowplaying':
          context.handleNowPlaying(bot, userClid);
          break;
        case 'queue':
        case 'add':
          await context.handleQueue(botId, bot, userClid, args);
          break;
        case 'shuffle':
          context.handleShuffle(bot, userClid, args);
          break;
        case 'stream':
          await context.handleStream(bot, userClid, args);
          break;
        case 'stopstream':
          await context.handleStopStream(bot, userClid);
          break;
        case 'viewers':
          context.handleViewers(bot, userClid);
          break;
        case 'channels':
          await context.handleChannels(bot, userClid, args);
          break;
        case 'tv':
        case 'iptv':
          await context.handleTv(bot, userClid, args);
          break;
        case 'lyrics':
          await context.handleLyrics(bot, userClid, args);
          break;
      }
    } catch (err: any) {
      console.error(`[MusicCmd] Error handling !${command}: ${err.message}`);
      context.reply(bot, userClid, `Error: ${err.message}`);
    }
    return;
  }

  // Admin-defined custom commands for this bot's server
  await context.handleCustomCommand(botId, bot, userClid, command);
  } finally {
    if (userClid) context.activeReplyChannel.delete(`${botId}:${userClid}`);
  }
}

/**
 * Send a command reply. When the command came from another channel, prefers the
 * SSH command-channel listener so the user sees the message where they typed.
 * Await this before joinChannel/refreshBotChannels — those disconnect the
 * listener and optimistically change the bot's channel id.
 */
export async function reply(
  context: CommandContext,
  bot: VoiceBot,
  targetClid: number,
  msg: string,
): Promise<void> {
  // A reply made after the flood block tripped part-way through a command is dropped too.
  if (bot.floodHoldActive) return;
  const botId = bot.currentConfig.id;
  const replyChannelId = context.activeReplyChannel.get(`${botId}:${targetClid}`);
  const cfg = context.botChannelConfig.get(botId);
  // Actual voice presence only — defaultChannel fallback made cross-channel
  // replies take the home-channel path while the bot was still elsewhere.
  const homeCid = bot.getCurrentChannelId() || 0;

  if (
    replyChannelId &&
    cfg &&
    context.eventBridge &&
    (homeCid <= 0 || replyChannelId !== homeCid)
  ) {
    const ok = await context.eventBridge.sendChannelText(
      cfg.serverConfigId,
      cfg.virtualServerId,
      replyChannelId,
      msg,
      { helperNickname: 'TS6 Helper' },
    );
    if (!ok) {
      console.warn(
        `[MusicCmd] Cross-channel reply failed for bot ${botId} cid=${replyChannelId}, falling back to home channel`,
      );
      try {
        bot.sendChannelMessage(msg);
      } catch (err: any) {
        console.error(`[MusicCmd] Failed to send reply: ${err.message}`);
      }
    }
    return;
  }

  try {
    bot.sendChannelMessage(msg);
  } catch (err: any) {
    console.error(`[MusicCmd] Failed to send reply: ${err.message}`);
  }
}

export function replyChannelForDedupe(
  context: CommandContext,
  botId: number,
  userClid: number,
  bot: VoiceBot,
): number {
  const active = context.activeReplyChannel.get(`${botId}:${userClid}`);
  if (active && active > 0) return active;
  const home = bot.getCurrentChannelId();
  if (home > 0) return home;
  const cfg = context.botChannelConfig.get(botId);
  return parseInt(cfg?.defaultChannel || '0', 10) || 0;
}

export function virtualServerIdForBot(context: CommandContext, botId: number): number {
  return context.botChannelConfig.get(botId)?.virtualServerId ?? 1;
}
