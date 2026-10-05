import type { PrismaClient } from '../../../generated/prisma/index.js';
import type { VoiceBotManager } from '../voice-bot-manager.js';
import type { VoiceBot } from '../voice-bot.js';
import type { QueueItem } from '../playlist/queue.js';
import type { EventBridge } from '../../bot-engine/event-bridge.js';
import type { findSongForQuery } from '../audio/youtube.js';

/** Whether a running bot flow on this server/SID answers `!commandName`. */
export type FlowCommandLookup = (serverConfigId: number, virtualServerId: number, commandName: string) => boolean;

export interface BotChannelConfig {
  serverConfigId: number;
  virtualServerId: number;
  defaultChannel: string | null;
  commandChannelIds: string[];
}

/** Internal callbacks retain the facade as the receiver, including asynchronous replies. */
export interface CommandMethods {
  setEventBridge(bridge: EventBridge): void;
  refreshAllBotChannels(): Promise<void>;
  refreshBotChannels(botId: number): Promise<void>;
  syncCommandListenersForPair(configId: number, sid: number): Promise<void>;
  syncCommandListenersForPairOnce(configId: number, sid: number): Promise<void>;
  scheduleMainHelperPark(configId: number, sid: number, channelId: number): void;
  scheduleMainHelperRebalance(configId: number, sid: number): void;
  rebalanceMainHelper(configId: number, sid: number): Promise<void>;
  parkMainHelper(configId: number, sid: number, channelId: number): Promise<void>;
  pairHasExplicitCommandChannels(configId: number, sid: number): boolean;
  mapBotsToAutoChannels(configId: number, sid: number, channelIds: number[]): void;
  discoverOccupiedCommandChannels(configId: number, sid: number): Promise<number[]>;
  absorbHomeChannelsFromClientList(configId: number, sid: number, raw: string): Promise<void>;
  unregisterBotChannels(botId: number): void;
  registerBot(botId: number, bot: VoiceBot): void;
  unregisterBot(botId: number): void;
  getNeededServerPairs(): string[];
  syncMusicSessionOwnership(): Promise<void>;
  onCrossChannelTextMessage(
    configId: number,
    sid: number,
    channelId: number,
    data: Record<string, string>,
  ): Promise<void>;
  getNeededCommandChannelIds(_configId: number, _sid: number): number[];
  onTextMessage(
    botId: number,
    bot: VoiceBot,
    data: Record<string, string>,
    replyChannelId?: number,
  ): Promise<void>;
  replyChannelForDedupe(botId: number, userClid: number, bot: VoiceBot): number;
  virtualServerIdForBot(botId: number): number;
  handleCustomCommandsList(botId: number, bot: VoiceBot, userClid: number): Promise<void>;
  handleHelp(botId: number, bot: VoiceBot, userClid: number): Promise<void>;
  handleHelpCrossChannel(
    configId: number,
    sid: number,
    channelId: number,
    data: Record<string, string>,
  ): Promise<void>;
  handleCustomCommand(botId: number, bot: VoiceBot, userClid: number, command: string): Promise<void>;
  reply(bot: VoiceBot, targetClid: number, msg: string): Promise<void>;
  handleRadio(botId: number, bot: VoiceBot, userClid: number, args: string): Promise<void>;
  joinChannelForCommand(botId: number, bot: VoiceBot, userClid: number): Promise<void>;
  listSummonableBots(
    serverConfigId: number,
    virtualServerId: number,
  ): Promise<Array<{ id: number; name: string; bot: VoiceBot }>>;
  formatHereBotList(
    bots: Array<{ id: number; name: string }>,
    opts?: { busy?: boolean; hereIds?: Set<number>; idleIds?: Set<number> },
  ): string;
  shouldSpeakHereList(
    serverConfigId: number,
    virtualServerId: number,
    channelId: number,
    userClid: number,
  ): boolean;
  resolveSummonCandidate(
    candidates: Array<{ id: number; name: string; bot: VoiceBot }>,
    channelId: number,
    serverConfigId: number,
    virtualServerId: number,
  ): Promise<
    | { kind: 'summon'; target: { id: number; name: string; bot: VoiceBot } }
    | {
        kind: 'list';
        bots: Array<{ id: number; name: string }>;
        busy: boolean;
        hereIds?: Set<number>;
        idleIds?: Set<number>;
      }
  >;
  isBotIdleForSummon(bot: VoiceBot, serverConfigId: number, virtualServerId: number): Promise<boolean>;
  musicBotClidsOnServer(serverConfigId: number, virtualServerId: number): Set<number>;
  countHumanPeersViaClientList(
    configId: number,
    sid: number,
    channelId: number,
    excludeClids: Set<number>,
  ): Promise<number | null>;
  summonBotToChannel(
    target: { id: number; name: string; bot: VoiceBot },
    channelId: number,
    replyBot: VoiceBot,
    userClid: number,
  ): Promise<void>;
  sshHelperOwnsChannel(configId: number, sid: number, channelId: number): boolean;
  resolveCommandChannelId(
    botId: number,
    bot: VoiceBot,
    userClid: number,
    hintChannelId?: number,
  ): Promise<number>;
  handleHere(botId: number, bot: VoiceBot, userClid: number, args: string): Promise<void>;
  handleHereCrossChannel(
    configId: number,
    sid: number,
    channelId: number,
    data: Record<string, string>,
    args: string,
  ): Promise<void>;
  handlePlay(botId: number, bot: VoiceBot, userClid: number, args: string): Promise<void>;
  enqueueMediaUrl(botId: number, bot: VoiceBot, userClid: number, rawUrl: string): Promise<void>;
  findSong(query: string): ReturnType<typeof findSongForQuery>;
  handlePlaylist(botId: number, bot: VoiceBot, userClid: number, args: string): Promise<void>;
  handleRepeat(bot: VoiceBot, userClid: number, args: string): void;
  handleSeek(bot: VoiceBot, userClid: number, args: string): Promise<void>;
  handleRemove(bot: VoiceBot, userClid: number, args: string): void;
  showQueue(bot: VoiceBot, userClid: number): void;
  handleQueue(botId: number, bot: VoiceBot, userClid: number, args: string): Promise<void>;
  handleStop(bot: VoiceBot, userClid: number): void;
  handlePause(bot: VoiceBot, userClid: number): void;
  handleShuffle(bot: VoiceBot, userClid: number, args: string): void;
  handleSkip(bot: VoiceBot, userClid: number): Promise<void>;
  handlePrev(bot: VoiceBot, userClid: number): Promise<void>;
  handleVolume(bot: VoiceBot, userClid: number, args: string): Promise<void>;
  handleNowPlaying(bot: VoiceBot, userClid: number): void;
  handleStream(bot: VoiceBot, userClid: number, args: string): Promise<void>;
  streamStartError(err: any): string;
  chatMusicSwitch(bot: VoiceBot): { replaceSessionIds: string[] };
  chatVideoSwitch(bot: VoiceBot): { replaceSessionIds: string[] };
  handleStopStream(bot: VoiceBot, userClid: number): Promise<void>;
  handleChannels(bot: VoiceBot, userClid: number, args: string): Promise<void>;
  handleTv(bot: VoiceBot, userClid: number, args: string): Promise<void>;
  handleLyrics(bot: VoiceBot, userClid: number, args: string): Promise<void>;
  handleViewers(bot: VoiceBot, userClid: number): void;
  saveMusicRequest(bot: VoiceBot, item: QueueItem): void;
}

/** Shared state of one handler; cooldown claims remain shared across handlers in dedupe.ts. */
export interface CommandContext extends CommandMethods {
  prisma: PrismaClient;
  voiceBotManager: VoiceBotManager;
  registeredBots: Set<number>;
  eventBridge: EventBridge | null;
  readonly flowCommandLookup: FlowCommandLookup | null;
  eventBridgeListening: boolean;
  botChannelConfig: Map<number, BotChannelConfig>;
  channelToBots: Map<string, Set<number>>;
  activeReplyChannel: Map<string, number>;
  autoCommandChannels: Map<string, number[]>;
  mainHelperParkTimers: Map<string, ReturnType<typeof setTimeout>>;
  mainHelperRebalanceTimers: Map<string, ReturnType<typeof setTimeout>>;
  syncingCommandPairs: Map<string, Promise<void>>;
  musicOwnedPairs: Set<string>;
}
