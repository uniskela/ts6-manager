import type { PrismaClient } from '../../../generated/prisma/index.js';
import type { VoiceBotManager } from '../voice-bot-manager.js';
import type { VoiceBot } from '../voice-bot.js';
import type { QueueItem } from '../playlist/queue.js';
import type { EventBridge } from '../../bot-engine/event-bridge.js';
import type { BotChannelConfig, CommandContext, FlowCommandLookup } from './context.js';
import * as routing from './routing.js';
import * as channelOwnership from './channel-ownership.js';
import * as playback from './playback.js';
import * as queue from './queue.js';
import * as streaming from './streaming.js';
import * as info from './info.js';
import * as summon from './summon.js';
import * as dedupe from './dedupe.js';
import { findSongForQuery } from '../audio/youtube.js';

/** Stable facade for voice and SSH chat commands. Implementations live in the command groups. */
export class MusicCommandHandler {
  private registeredBots = new Set<number>();
  private eventBridge: EventBridge | null = null;
  private flowCommandLookup: FlowCommandLookup | null = null;
  private eventBridgeListening = false;
  private botChannelConfig = new Map<number, BotChannelConfig>();
  private channelToBots = new Map<string, Set<number>>();
  private activeReplyChannel = new Map<string, number>();
  /** Channels the roaming helper recently covered (key: configId:sid) — for mapping only. */
  private autoCommandChannels = new Map<string, number[]>();
  private mainHelperParkTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Debounced rebalance after music-bot moves (do not follow the bot with the helper). */
  private mainHelperRebalanceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Coalesce concurrent bot refreshes for the same connection/SID pair. */
  private syncingCommandPairs = new Map<string, Promise<void>>();
  /** Pairs retained under the `music` EventBridge session owner. */
  private musicOwnedPairs = new Set<string>();

  constructor(
    private prisma: PrismaClient,
    private voiceBotManager: VoiceBotManager,
  ) {}

  private readonly context = this.createContext();

  private createContext(): CommandContext {
    const handler = this;
    // Read through to the facade so refreshed dependencies and replaced callbacks stay live.
    return {
      get prisma() { return handler.prisma; },
      get voiceBotManager() { return handler.voiceBotManager; },
      get registeredBots() { return handler.registeredBots; },
      get eventBridge() { return handler.eventBridge; },
      set eventBridge(value) { handler.eventBridge = value; },
      get flowCommandLookup() { return handler.flowCommandLookup; },
      get eventBridgeListening() { return handler.eventBridgeListening; },
      set eventBridgeListening(value) { handler.eventBridgeListening = value; },
      get botChannelConfig() { return handler.botChannelConfig; },
      get channelToBots() { return handler.channelToBots; },
      get activeReplyChannel() { return handler.activeReplyChannel; },
      get autoCommandChannels() { return handler.autoCommandChannels; },
      get mainHelperParkTimers() { return handler.mainHelperParkTimers; },
      get mainHelperRebalanceTimers() { return handler.mainHelperRebalanceTimers; },
      get syncingCommandPairs() { return handler.syncingCommandPairs; },
      get musicOwnedPairs() { return handler.musicOwnedPairs; },
      setEventBridge: (...args) => handler.setEventBridge(...args),
      refreshAllBotChannels: (...args) => handler.refreshAllBotChannels(...args),
      refreshBotChannels: (...args) => handler.refreshBotChannels(...args),
      syncCommandListenersForPair: (...args) => handler.syncCommandListenersForPair(...args),
      syncCommandListenersForPairOnce: (...args) => handler.syncCommandListenersForPairOnce(...args),
      scheduleMainHelperPark: (...args) => handler.scheduleMainHelperPark(...args),
      scheduleMainHelperRebalance: (...args) => handler.scheduleMainHelperRebalance(...args),
      rebalanceMainHelper: (...args) => handler.rebalanceMainHelper(...args),
      parkMainHelper: (...args) => handler.parkMainHelper(...args),
      pairHasExplicitCommandChannels: (...args) => handler.pairHasExplicitCommandChannels(...args),
      mapBotsToAutoChannels: (...args) => handler.mapBotsToAutoChannels(...args),
      discoverOccupiedCommandChannels: (...args) => handler.discoverOccupiedCommandChannels(...args),
      absorbHomeChannelsFromClientList: (...args) => handler.absorbHomeChannelsFromClientList(...args),
      unregisterBotChannels: (...args) => handler.unregisterBotChannels(...args),
      registerBot: (...args) => handler.registerBot(...args),
      unregisterBot: (...args) => handler.unregisterBot(...args),
      getNeededServerPairs: (...args) => handler.getNeededServerPairs(...args),
      syncMusicSessionOwnership: (...args) => handler.syncMusicSessionOwnership(...args),
      onCrossChannelTextMessage: (...args) => handler.onCrossChannelTextMessage(...args),
      getNeededCommandChannelIds: (...args) => handler.getNeededCommandChannelIds(...args),
      onTextMessage: (...args) => handler.onTextMessage(...args),
      replyChannelForDedupe: (...args) => handler.replyChannelForDedupe(...args),
      virtualServerIdForBot: (...args) => handler.virtualServerIdForBot(...args),
      handleCustomCommandsList: (...args) => handler.handleCustomCommandsList(...args),
      handleHelp: (...args) => handler.handleHelp(...args),
      handleHelpCrossChannel: (...args) => handler.handleHelpCrossChannel(...args),
      handleCustomCommand: (...args) => handler.handleCustomCommand(...args),
      reply: (...args) => handler.reply(...args),
      handleRadio: (...args) => handler.handleRadio(...args),
      joinChannelForCommand: (...args) => handler.joinChannelForCommand(...args),
      listSummonableBots: (...args) => handler.listSummonableBots(...args),
      formatHereBotList: (...args) => handler.formatHereBotList(...args),
      shouldSpeakHereList: (...args) => handler.shouldSpeakHereList(...args),
      resolveSummonCandidate: (...args) => handler.resolveSummonCandidate(...args),
      isBotIdleForSummon: (...args) => handler.isBotIdleForSummon(...args),
      musicBotClidsOnServer: (...args) => handler.musicBotClidsOnServer(...args),
      countHumanPeersViaClientList: (...args) => handler.countHumanPeersViaClientList(...args),
      summonBotToChannel: (...args) => handler.summonBotToChannel(...args),
      sshHelperOwnsChannel: (...args) => handler.sshHelperOwnsChannel(...args),
      resolveCommandChannelId: (...args) => handler.resolveCommandChannelId(...args),
      handleHere: (...args) => handler.handleHere(...args),
      handleHereCrossChannel: (...args) => handler.handleHereCrossChannel(...args),
      handlePlay: (...args) => handler.handlePlay(...args),
      enqueueMediaUrl: (...args) => handler.enqueueMediaUrl(...args),
      findSong: (...args) => handler.findSong(...args),
      handlePlaylist: (...args) => handler.handlePlaylist(...args),
      handleRepeat: (...args) => handler.handleRepeat(...args),
      handleSeek: (...args) => handler.handleSeek(...args),
      handleRemove: (...args) => handler.handleRemove(...args),
      showQueue: (...args) => handler.showQueue(...args),
      handleQueue: (...args) => handler.handleQueue(...args),
      handleStop: (...args) => handler.handleStop(...args),
      handlePause: (...args) => handler.handlePause(...args),
      handleShuffle: (...args) => handler.handleShuffle(...args),
      handleSkip: (...args) => handler.handleSkip(...args),
      handlePrev: (...args) => handler.handlePrev(...args),
      handleVolume: (...args) => handler.handleVolume(...args),
      handleNowPlaying: (...args) => handler.handleNowPlaying(...args),
      handleStream: (...args) => handler.handleStream(...args),
      streamStartError: (...args) => handler.streamStartError(...args),
      chatMusicSwitch: (...args) => handler.chatMusicSwitch(...args),
      chatVideoSwitch: (...args) => handler.chatVideoSwitch(...args),
      handleStopStream: (...args) => handler.handleStopStream(...args),
      handleChannels: (...args) => handler.handleChannels(...args),
      handleTv: (...args) => handler.handleTv(...args),
      handleLyrics: (...args) => handler.handleLyrics(...args),
      handleViewers: (...args) => handler.handleViewers(...args),
      saveMusicRequest: (...args) => handler.saveMusicRequest(...args),
    };
  }

  /** Lets the bot engine say which `!commands` its flows handle, so they are not reported as unknown. */
  setFlowCommandLookup(lookup: FlowCommandLookup): void {
    this.flowCommandLookup = lookup;
  }

  setEventBridge(bridge: EventBridge): void {
    return routing.setEventBridge(this.context, bridge);
  }

  refreshAllBotChannels(): Promise<void> {
    return channelOwnership.refreshAllBotChannels(this.context);
  }

  refreshBotChannels(botId: number): Promise<void> {
    return channelOwnership.refreshBotChannels(this.context, botId);
  }

  syncCommandListenersForPair(configId: number, sid: number): Promise<void> {
    return channelOwnership.syncCommandListenersForPair(this.context, configId, sid);
  }

  private syncCommandListenersForPairOnce(configId: number, sid: number): Promise<void> {
    return channelOwnership.syncCommandListenersForPairOnce(this.context, configId, sid);
  }

  private scheduleMainHelperPark(configId: number, sid: number, channelId: number): void {
    return channelOwnership.scheduleMainHelperPark(this.context, configId, sid, channelId);
  }

  private scheduleMainHelperRebalance(configId: number, sid: number): void {
    return channelOwnership.scheduleMainHelperRebalance(this.context, configId, sid);
  }

  private rebalanceMainHelper(configId: number, sid: number): Promise<void> {
    return channelOwnership.rebalanceMainHelper(this.context, configId, sid);
  }

  private parkMainHelper(configId: number, sid: number, channelId: number): Promise<void> {
    return channelOwnership.parkMainHelper(this.context, configId, sid, channelId);
  }

  private pairHasExplicitCommandChannels(configId: number, sid: number): boolean {
    return channelOwnership.pairHasExplicitCommandChannels(this.context, configId, sid);
  }

  private mapBotsToAutoChannels(configId: number, sid: number, channelIds: number[]): void {
    return channelOwnership.mapBotsToAutoChannels(this.context, configId, sid, channelIds);
  }

  private discoverOccupiedCommandChannels(configId: number, sid: number): Promise<number[]> {
    return channelOwnership.discoverOccupiedCommandChannels(this.context, configId, sid);
  }

  private absorbHomeChannelsFromClientList(configId: number, sid: number, raw: string): Promise<void> {
    return channelOwnership.absorbHomeChannelsFromClientList(this.context, configId, sid, raw);
  }

  private unregisterBotChannels(botId: number): void {
    return channelOwnership.unregisterBotChannels(this.context, botId);
  }

  registerBot(botId: number, bot: VoiceBot): void {
    return routing.registerBot(this.context, botId, bot);
  }

  unregisterBot(botId: number): void {
    return channelOwnership.unregisterBot(this.context, botId);
  }

  getNeededServerPairs(): string[] {
    return channelOwnership.getNeededServerPairs(this.context);
  }

  syncMusicSessionOwnership(): Promise<void> {
    return channelOwnership.syncMusicSessionOwnership(this.context);
  }

  private onCrossChannelTextMessage(
    configId: number,
    sid: number,
    channelId: number,
    data: Record<string, string>,
  ): Promise<void> {
    return routing.onCrossChannelTextMessage(this.context, configId, sid, channelId, data);
  }

  getNeededCommandChannelIds(_configId: number, _sid: number): number[] {
    return channelOwnership.getNeededCommandChannelIds(this.context, _configId, _sid);
  }

  private onTextMessage(
    botId: number,
    bot: VoiceBot,
    data: Record<string, string>,
    replyChannelId?: number,
  ): Promise<void> {
    return routing.onTextMessage(this.context, botId, bot, data, replyChannelId);
  }

  private replyChannelForDedupe(botId: number, userClid: number, bot: VoiceBot): number {
    return routing.replyChannelForDedupe(this.context, botId, userClid, bot);
  }

  private virtualServerIdForBot(botId: number): number {
    return routing.virtualServerIdForBot(this.context, botId);
  }

  private handleCustomCommandsList(botId: number, bot: VoiceBot, userClid: number): Promise<void> {
    return info.handleCustomCommandsList(this.context, botId, bot, userClid);
  }

  private handleHelp(botId: number, bot: VoiceBot, userClid: number): Promise<void> {
    return info.handleHelp(this.context, botId, bot, userClid);
  }

  private handleHelpCrossChannel(
    configId: number,
    sid: number,
    channelId: number,
    data: Record<string, string>,
  ): Promise<void> {
    return info.handleHelpCrossChannel(this.context, configId, sid, channelId, data);
  }

  private handleCustomCommand(botId: number, bot: VoiceBot, userClid: number, command: string): Promise<void> {
    return info.handleCustomCommand(this.context, botId, bot, userClid, command);
  }

  private reply(bot: VoiceBot, targetClid: number, msg: string): Promise<void> {
    return routing.reply(this.context, bot, targetClid, msg);
  }

  private handleRadio(botId: number, bot: VoiceBot, userClid: number, args: string): Promise<void> {
    return playback.handleRadio(this.context, botId, bot, userClid, args);
  }

  private joinChannelForCommand(botId: number, bot: VoiceBot, userClid: number): Promise<void> {
    return channelOwnership.joinChannelForCommand(this.context, botId, bot, userClid);
  }

  private listSummonableBots(
    serverConfigId: number,
    virtualServerId: number,
  ): Promise<Array<{ id: number; name: string; bot: VoiceBot }>> {
    return summon.listSummonableBots(this.context, serverConfigId, virtualServerId);
  }

  private formatHereBotList(
    bots: Array<{ id: number; name: string }>,
    opts?: { busy?: boolean; hereIds?: Set<number>; idleIds?: Set<number> },
  ): string {
    return summon.formatHereBotList(this.context, bots, opts);
  }

  private shouldSpeakHereList(
    serverConfigId: number,
    virtualServerId: number,
    channelId: number,
    userClid: number,
  ): boolean {
    return dedupe.shouldSpeakHereList(this.context, serverConfigId, virtualServerId, channelId, userClid);
  }

  private resolveSummonCandidate(
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
  > {
    return summon.resolveSummonCandidate(this.context, candidates, channelId, serverConfigId, virtualServerId);
  }

  private isBotIdleForSummon(bot: VoiceBot, serverConfigId: number, virtualServerId: number): Promise<boolean> {
    return channelOwnership.isBotIdleForSummon(this.context, bot, serverConfigId, virtualServerId);
  }

  private musicBotClidsOnServer(serverConfigId: number, virtualServerId: number): Set<number> {
    return channelOwnership.musicBotClidsOnServer(this.context, serverConfigId, virtualServerId);
  }

  private countHumanPeersViaClientList(
    configId: number,
    sid: number,
    channelId: number,
    excludeClids: Set<number>,
  ): Promise<number | null> {
    return channelOwnership.countHumanPeersViaClientList(this.context, configId, sid, channelId, excludeClids);
  }

  private summonBotToChannel(
    target: { id: number; name: string; bot: VoiceBot },
    channelId: number,
    replyBot: VoiceBot,
    userClid: number,
  ): Promise<void> {
    return summon.summonBotToChannel(this.context, target, channelId, replyBot, userClid);
  }

  private sshHelperOwnsChannel(configId: number, sid: number, channelId: number): boolean {
    return channelOwnership.sshHelperOwnsChannel(this.context, configId, sid, channelId);
  }

  private resolveCommandChannelId(
    botId: number,
    bot: VoiceBot,
    userClid: number,
    hintChannelId?: number,
  ): Promise<number> {
    return channelOwnership.resolveCommandChannelId(this.context, botId, bot, userClid, hintChannelId);
  }

  private handleHere(botId: number, bot: VoiceBot, userClid: number, args: string): Promise<void> {
    return summon.handleHere(this.context, botId, bot, userClid, args);
  }

  private handleHereCrossChannel(
    configId: number,
    sid: number,
    channelId: number,
    data: Record<string, string>,
    args: string,
  ): Promise<void> {
    return summon.handleHereCrossChannel(this.context, configId, sid, channelId, data, args);
  }

  private handlePlay(botId: number, bot: VoiceBot, userClid: number, args: string): Promise<void> {
    return playback.handlePlay(this.context, botId, bot, userClid, args);
  }

  private enqueueMediaUrl(botId: number, bot: VoiceBot, userClid: number, rawUrl: string): Promise<void> {
    return queue.enqueueMediaUrl(this.context, botId, bot, userClid, rawUrl);
  }

  private findSong(query: string): ReturnType<typeof findSongForQuery> {
    return findSongForQuery(query);
  }

  private handlePlaylist(botId: number, bot: VoiceBot, userClid: number, args: string): Promise<void> {
    return queue.handlePlaylist(this.context, botId, bot, userClid, args);
  }

  private handleRepeat(bot: VoiceBot, userClid: number, args: string): void {
    return queue.handleRepeat(this.context, bot, userClid, args);
  }

  private handleSeek(bot: VoiceBot, userClid: number, args: string): Promise<void> {
    return playback.handleSeek(this.context, bot, userClid, args);
  }

  private handleRemove(bot: VoiceBot, userClid: number, args: string): void {
    return queue.handleRemove(this.context, bot, userClid, args);
  }

  private showQueue(bot: VoiceBot, userClid: number): void {
    return queue.showQueue(this.context, bot, userClid);
  }

  private handleQueue(botId: number, bot: VoiceBot, userClid: number, args: string): Promise<void> {
    return queue.handleQueue(this.context, botId, bot, userClid, args);
  }

  private handleStop(bot: VoiceBot, userClid: number): void {
    return playback.handleStop(this.context, bot, userClid);
  }

  private handlePause(bot: VoiceBot, userClid: number): void {
    return playback.handlePause(this.context, bot, userClid);
  }

  private handleShuffle(bot: VoiceBot, userClid: number, args: string): void {
    return queue.handleShuffle(this.context, bot, userClid, args);
  }

  private handleSkip(bot: VoiceBot, userClid: number): Promise<void> {
    return playback.handleSkip(this.context, bot, userClid);
  }

  private handlePrev(bot: VoiceBot, userClid: number): Promise<void> {
    return playback.handlePrev(this.context, bot, userClid);
  }

  private handleVolume(bot: VoiceBot, userClid: number, args: string): Promise<void> {
    return playback.handleVolume(this.context, bot, userClid, args);
  }

  private handleNowPlaying(bot: VoiceBot, userClid: number): void {
    return info.handleNowPlaying(this.context, bot, userClid);
  }

  private handleStream(bot: VoiceBot, userClid: number, args: string): Promise<void> {
    return streaming.handleStream(this.context, bot, userClid, args);
  }

  private streamStartError(err: any): string {
    return streaming.streamStartError(this.context, err);
  }

  private chatMusicSwitch(bot: VoiceBot): { replaceSessionIds: string[] } {
    return channelOwnership.chatMusicSwitch(this.context, bot);
  }

  private chatVideoSwitch(bot: VoiceBot): { replaceSessionIds: string[] } {
    return channelOwnership.chatVideoSwitch(this.context, bot);
  }

  private handleStopStream(bot: VoiceBot, userClid: number): Promise<void> {
    return streaming.handleStopStream(this.context, bot, userClid);
  }

  private handleChannels(bot: VoiceBot, userClid: number, args: string): Promise<void> {
    return streaming.handleChannels(this.context, bot, userClid, args);
  }

  private handleTv(bot: VoiceBot, userClid: number, args: string): Promise<void> {
    return streaming.handleTv(this.context, bot, userClid, args);
  }

  private handleLyrics(bot: VoiceBot, userClid: number, args: string): Promise<void> {
    return info.handleLyrics(this.context, bot, userClid, args);
  }

  private handleViewers(bot: VoiceBot, userClid: number): void {
    return info.handleViewers(this.context, bot, userClid);
  }

  private saveMusicRequest(bot: VoiceBot, item: QueueItem): void {
    return queue.saveMusicRequest(this.context, bot, item);
  }
}
