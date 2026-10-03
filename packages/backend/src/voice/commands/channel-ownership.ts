import type { VoiceBot } from '../voice-bot.js';
import { channelListenerKey, parseCommandChannelIds } from '../music-command-channels.js';
import type { CommandContext } from './context.js';
import type { BotChannelConfig } from './context.js';
/** Debounce parking the main SSH helper when humans move between channels. */
const MAIN_HELPER_PARK_DEBOUNCE_MS = 800;
/** Exclude stopped, errored, and still-starting bots from summon candidates. */
export function isBotSummonable(bot: VoiceBot): boolean {
  return bot.status !== 'stopped' && bot.status !== 'error' && bot.status !== 'starting';
}

/**
 * True when a music voice client is (or is connecting) in `channelId`.
 * Includes `starting` — reconnect races must not park the SSH helper onto the
 * bot's channel and abandon humans elsewhere (cross-channel !here/!help go silent).
 */
export function botOccupiesChannel(bot: VoiceBot, channelId: number): boolean {
  if (channelId <= 0) return false;
  if (bot.status === 'stopped' || bot.status === 'error') return false;
  return bot.getCurrentChannelId() === channelId;
}

/** Refresh channel mappings for every configured music bot. */
export async function refreshAllBotChannels(context: CommandContext): Promise<void> {
  const bots = await context.prisma.musicBot.findMany({ select: { id: true } });
  for (const b of bots) {
    await context.refreshBotChannels(b.id);
  }
}

/** Reload one bot’s channels and reconcile helper coverage and session ownership. */
export async function refreshBotChannels(context: CommandContext, botId: number): Promise<void> {
  const prevCfg = context.botChannelConfig.get(botId);

  const dbBot = await context.prisma.musicBot.findUnique({ where: { id: botId } });
  if (!dbBot) {
    context.unregisterBotChannels(botId);
    if (prevCfg) {
      await context.syncCommandListenersForPair(prevCfg.serverConfigId, prevCfg.virtualServerId);
    }
    await context.syncMusicSessionOwnership();
    return;
  }

  context.unregisterBotChannels(botId);

  const commandChannelIds = parseCommandChannelIds(dbBot.commandChannelIds);
  const cfg: BotChannelConfig = {
    serverConfigId: dbBot.serverConfigId,
    virtualServerId: dbBot.virtualServerId ?? 1,
    defaultChannel: dbBot.defaultChannel,
    commandChannelIds,
  };
  context.botChannelConfig.set(botId, cfg);

  for (const cidStr of commandChannelIds) {
    const channelId = parseInt(cidStr, 10);
    if (!channelId) continue;
    const key = channelListenerKey(cfg.serverConfigId, cfg.virtualServerId, channelId);
    if (!context.channelToBots.has(key)) context.channelToBots.set(key, new Set());
    context.channelToBots.get(key)!.add(botId);
  }

  if (commandChannelIds.length === 0) {
    console.log(
      `[MusicCmd] Bot ${botId}: empty commandChannelIds — ` +
        `same-channel voice cmds + main SSH roaming helper for cross-channel`,
    );
  } else {
    console.log(
      `[MusicCmd] Bot ${botId}: command channels=[${commandChannelIds.join(',')}] ` +
        `vs=${cfg.virtualServerId} config=${cfg.serverConfigId}`,
    );
  }

  await context.syncCommandListenersForPair(cfg.serverConfigId, cfg.virtualServerId);
  if (
    prevCfg &&
    (prevCfg.serverConfigId !== cfg.serverConfigId ||
      prevCfg.virtualServerId !== cfg.virtualServerId)
  ) {
    await context.syncCommandListenersForPair(prevCfg.serverConfigId, prevCfg.virtualServerId);
  }
  await context.syncMusicSessionOwnership();
}

/**
 * Music no longer opens per-channel CMD SSH listeners (Query flood on bot join).
 * Tear down leftovers from older tips and park the main SSH helper where humans are.
 */
export async function syncCommandListenersForPair(
  context: CommandContext,
  configId: number,
  sid: number,
): Promise<void> {
  const pairKey = `${configId}:${sid}`;
  const pending = context.syncingCommandPairs.get(pairKey);
  if (pending) return pending;

  const run = context.syncCommandListenersForPairOnce(configId, sid);
  context.syncingCommandPairs.set(pairKey, run);
  try {
    await run;
  } finally {
    if (context.syncingCommandPairs.get(pairKey) === run) {
      context.syncingCommandPairs.delete(pairKey);
    }
  }
}

/** Remove leftover music listeners and park the roaming helper with humans. */
export async function syncCommandListenersForPairOnce(
  context: CommandContext,
  configId: number,
  sid: number,
): Promise<void> {
  if (!context.eventBridge) {
    console.warn(
      `[MusicCmd] syncCommandListeners skipped ${configId}:${sid}: no eventBridge`,
    );
    return;
  }

  const pairKey = `${configId}:${sid}`;
  const previousAuto = context.autoCommandChannels.get(pairKey) || [];
  context.autoCommandChannels.delete(pairKey);

  const musicOwned = new Set<number>(previousAuto);
  for (const cfg of context.botChannelConfig.values()) {
    if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) continue;
    for (const cidStr of cfg.commandChannelIds) {
      const n = parseInt(cidStr, 10);
      if (n > 0) musicOwned.add(n);
    }
  }

  const existing = context.eventBridge.getCommandListenerChannelIds(configId, sid);
  // Empty commandChannelIds used to open occupied helpers — drop all leftovers for
  // this pair. Explicit configs only drop music-owned cids (leave BotEngine flows).
  const hasExplicit = context.pairHasExplicitCommandChannels(configId, sid);
  const toDrop = hasExplicit
    ? existing.filter((cid) => musicOwned.has(cid))
    : existing.slice();
  for (const channelId of toDrop) {
    try {
      await context.eventBridge.disconnectCommandListener(configId, sid, channelId);
    } catch {
      /* ignore */
    }
  }
  if (toDrop.length > 0) {
    console.log(
      `[MusicCmd] Disconnected leftover CMD listeners for ${pairKey}: [${toDrop.join(',')}]`,
    );
  }

  // Park main helper in one occupied human channel so cross-channel cmds work
  // without a second Query login. Voice bots already cover their own homes.
  const occupied = await context.discoverOccupiedCommandChannels(configId, sid);
  if (occupied.length > 0) {
    const parkCid = occupied[0]!;
    const ok = await context.eventBridge.ensureHelperInChannel(configId, sid, parkCid);
    if (ok) {
      context.autoCommandChannels.set(pairKey, [parkCid]);
      context.mapBotsToAutoChannels(configId, sid, [parkCid]);
      console.log(
        `[MusicCmd] Main SSH helper parked in cid=${parkCid} for ${pairKey} ` +
          `(occupied=[${occupied.join(',')}]; no CMD listeners)`,
      );
    }
  } else {
    console.log(
      `[MusicCmd] No human-occupied channel to park helper for ${pairKey} yet ` +
        `(will park on cliententer/move)`,
    );
  }
}

/** Debounce helper parking while leaving channels covered by voice bots alone. */
export function scheduleMainHelperPark(
  context: CommandContext,
  configId: number,
  sid: number,
  channelId: number,
): void {
  if (channelId <= 0) return;
  let hasBots = false;
  for (const [botId, cfg] of context.botChannelConfig) {
    if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) continue;
    hasBots = true;
    const bot = context.voiceBotManager.getBot(botId);
    // Voice bot already covers that channel (incl. reconnect/starting) — cover humans elsewhere.
    if (bot && botOccupiesChannel(bot, channelId)) {
      context.scheduleMainHelperRebalance(configId, sid);
      return;
    }
  }
  if (!hasBots || !context.eventBridge) return;

  const pairKey = `${configId}:${sid}`;
  const prev = context.mainHelperParkTimers.get(pairKey);
  if (prev) clearTimeout(prev);
  context.mainHelperParkTimers.set(
    pairKey,
    setTimeout(() => {
      context.mainHelperParkTimers.delete(pairKey);
      void context.parkMainHelper(configId, sid, channelId).catch((err: any) => {
        console.warn(
          `[MusicCmd] Main helper park ${pairKey} cid=${channelId}: ${err?.message || err}`,
        );
      });
    }, MAIN_HELPER_PARK_DEBOUNCE_MS),
  );
}

/**
 * Re-park the main SSH helper into a human-only channel (never a music-bot home).
 * Used after music bots move/reconnect so cross-channel cmds keep working.
 */
export function scheduleMainHelperRebalance(context: CommandContext, configId: number, sid: number): void {
  if (!context.eventBridge) return;
  let hasBots = false;
  for (const cfg of context.botChannelConfig.values()) {
    if (cfg.serverConfigId === configId && cfg.virtualServerId === sid) {
      hasBots = true;
      break;
    }
  }
  if (!hasBots) return;

  const pairKey = `${configId}:${sid}`;
  const prev = context.mainHelperRebalanceTimers.get(pairKey);
  if (prev) clearTimeout(prev);
  context.mainHelperRebalanceTimers.set(
    pairKey,
    setTimeout(() => {
      context.mainHelperRebalanceTimers.delete(pairKey);
      void context.rebalanceMainHelper(configId, sid).catch((err: any) => {
        console.warn(
          `[MusicCmd] Main helper rebalance ${pairKey}: ${err?.message || err}`,
        );
      });
    }, MAIN_HELPER_PARK_DEBOUNCE_MS),
  );
}

/** Park the roaming helper in the first human-occupied channel it can cover. */
export async function rebalanceMainHelper(
  context: CommandContext,
  configId: number,
  sid: number,
): Promise<void> {
  if (!context.eventBridge) return;
  const occupied = await context.discoverOccupiedCommandChannels(configId, sid);
  const pairKey = `${configId}:${sid}`;
  if (occupied.length === 0) {
    console.log(
      `[MusicCmd] No human-occupied channel to park helper for ${pairKey} yet ` +
        `(will park on cliententer/move)`,
    );
    return;
  }
  const parkCid = occupied[0]!;
  const ok = await context.eventBridge.ensureHelperInChannel(configId, sid, parkCid);
  if (!ok) return;
  context.autoCommandChannels.set(pairKey, [parkCid]);
  context.mapBotsToAutoChannels(configId, sid, [parkCid]);
  console.log(
    `[MusicCmd] Main SSH helper listening in cid=${parkCid} for ${pairKey} ` +
      `(rebalance; occupied=[${occupied.join(',')}])`,
  );
}

/** Park the helper in a requested channel, rebalancing if a voice bot covers it. */
export async function parkMainHelper(
  context: CommandContext,
  configId: number,
  sid: number,
  channelId: number,
): Promise<void> {
  if (!context.eventBridge || channelId <= 0) return;
  // Re-check voice ownership after debounce (incl. starting/reconnect).
  for (const [botId, cfg] of context.botChannelConfig) {
    if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) continue;
    const bot = context.voiceBotManager.getBot(botId);
    if (bot && botOccupiesChannel(bot, channelId)) {
      await context.rebalanceMainHelper(configId, sid);
      return;
    }
  }
  const ok = await context.eventBridge.ensureHelperInChannel(configId, sid, channelId);
  if (!ok) return;
  const pairKey = `${configId}:${sid}`;
  context.autoCommandChannels.set(pairKey, [channelId]);
  context.mapBotsToAutoChannels(configId, sid, [channelId]);
  console.log(
    `[MusicCmd] Main SSH helper listening in cid=${channelId} for ${pairKey}`,
  );
}

/** Report whether any bot on this server pair has explicit command channels. */
export function pairHasExplicitCommandChannels(
  context: CommandContext,
  configId: number,
  sid: number,
): boolean {
  for (const cfg of context.botChannelConfig.values()) {
    if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) continue;
    if (cfg.commandChannelIds.length > 0) return true;
  }
  return false;
}

/** Associate bots on one server pair with channels covered by the roaming helper. */
export function mapBotsToAutoChannels(
  context: CommandContext,
  configId: number,
  sid: number,
  channelIds: number[],
): void {
  const botIds: number[] = [];
  for (const [botId, cfg] of context.botChannelConfig) {
    if (cfg.serverConfigId === configId && cfg.virtualServerId === sid) {
      botIds.push(botId);
    }
  }
  for (const channelId of channelIds) {
    const key = channelListenerKey(configId, sid, channelId);
    if (!context.channelToBots.has(key)) context.channelToBots.set(key, new Set());
    for (const botId of botIds) {
      context.channelToBots.get(key)!.add(botId);
    }
  }
}

/**
 * Discover channels that currently have human clients (not Query clients, not music bots).
 * Used only to park the single main SSH helper — never to open N listeners.
 */
export async function discoverOccupiedCommandChannels(
  context: CommandContext,
  configId: number,
  sid: number,
): Promise<number[]> {
  if (!context.eventBridge) return [];
  try {
    const botHomes = new Set<number>();
    for (const [botId, cfg] of context.botChannelConfig) {
      if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) continue;
      const bot = context.voiceBotManager.getBot(botId);
      const home = bot?.getCurrentChannelId() || 0;
      if (home > 0) botHomes.add(home);
    }
    const musicClids = context.musicBotClidsOnServer(configId, sid);

    const raw = await context.eventBridge.executeCommand(configId, sid, 'clientlist');
    await context.absorbHomeChannelsFromClientList(configId, sid, raw);

    const { parseQueryResponse } = await import('@ts6/common');
    const humanCids = new Set<number>();
    for (const line of raw.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('error ')) continue;
      for (const entry of parseQueryResponse(trimmed)) {
        if (String(entry.client_type) === '1') continue; // Query / SSH helpers
        const clid = parseInt(entry.clid || '0', 10);
        if (clid > 0 && musicClids.has(clid)) continue; // parked music bots ≠ human occupancy
        const cid = parseInt(entry.cid || entry.client_channel_id || '0', 10);
        if (cid <= 0 || botHomes.has(cid)) continue;
        humanCids.add(cid);
      }
    }
    return Array.from(humanCids).sort((a, b) => a - b);
  } catch (err: any) {
    console.warn(
      `[MusicCmd] Occupied-channel discovery failed for ${configId}:${sid}: ${err.message}`,
    );
    return [];
  }
}

/** When voice left homeCid=0, learn each bot's channel from an SSH clientlist snapshot. */
export async function absorbHomeChannelsFromClientList(
  context: CommandContext,
  configId: number,
  sid: number,
  raw: string,
): Promise<void> {
  const { parseQueryResponse } = await import('@ts6/common');
  const byClid = new Map<number, number>();
  for (const line of raw.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('error ')) continue;
    for (const entry of parseQueryResponse(trimmed)) {
      const clid = parseInt(entry.clid || '0', 10);
      const cid = parseInt(entry.cid || entry.client_channel_id || '0', 10);
      if (clid > 0 && cid > 0) byClid.set(clid, cid);
    }
  }
  for (const [botId, cfg] of context.botChannelConfig) {
    if (cfg.serverConfigId !== configId || cfg.virtualServerId !== sid) continue;
    const bot = context.voiceBotManager.getBot(botId);
    if (!bot || bot.getCurrentChannelId() > 0) continue;
    const clid = bot.ts3ClientId || 0;
    if (clid <= 0) continue;
    const cid = byClid.get(clid);
    if (
      cid &&
      typeof bot.setCurrentChannelIdIfUnknown === 'function' &&
      bot.setCurrentChannelIdIfUnknown(cid)
    ) {
      console.log(`[MusicCmd] Bot ${botId}: learned homeCid=${cid} from SSH clientlist`);
    }
  }
}

/** Remove a bot’s configuration and membership from command channel mappings. */
export function unregisterBotChannels(context: CommandContext, botId: number): void {
  context.botChannelConfig.delete(botId);
  for (const bots of context.channelToBots.values()) {
    bots.delete(botId);
  }
}

/** Remove bot registration and reconcile its previous helper and session owners. */
export function unregisterBot(context: CommandContext, botId: number): void {
  const prevCfg = context.botChannelConfig.get(botId);
  context.registeredBots.delete(botId);
  context.unregisterBotChannels(botId);
  if (prevCfg) {
    void context.syncCommandListenersForPair(prevCfg.serverConfigId, prevCfg.virtualServerId);
  }
  void context.syncMusicSessionOwnership();
}

/** Virtual-server pairs that need main SSH for send + roaming helper park. */
export function getNeededServerPairs(context: CommandContext): string[] {
  const pairs = new Set<string>();
  for (const cfg of context.botChannelConfig.values()) {
    // Main SSH only — music never opens per-channel CMD listeners.
    pairs.add(`${cfg.serverConfigId}:${cfg.virtualServerId}`);
  }
  return Array.from(pairs);
}

/**
 * Keep music session ownership in sync with configured bots.
 * Releasing music must not disconnect flow/journal consumers.
 */
export async function syncMusicSessionOwnership(context: CommandContext): Promise<void> {
  if (!context.eventBridge) return;
  const needed = new Set(context.getNeededServerPairs());

  for (const pair of needed) {
    if (context.musicOwnedPairs.has(pair)) continue;
    const [configId, sid] = pair.split(':').map(Number);
    try {
      await context.eventBridge.retainSession('music', configId, sid);
      context.musicOwnedPairs.add(pair);
    } catch (err: any) {
      console.error(`[MusicCmd] Music session retain failed for ${pair}: ${err.message}`);
    }
  }

  for (const pair of [...context.musicOwnedPairs]) {
    if (needed.has(pair)) continue;
    const [configId, sid] = pair.split(':').map(Number);
    await context.eventBridge.releaseSession('music', configId, sid);
    context.musicOwnedPairs.delete(pair);
  }
}

/**
 * Music never opens per-channel CMD SSH listeners (Query 524 flood).
 * Cross-channel receive uses the single main EventBridge helper parked via
 * ensureHelperInChannel; BotEngine must not merge music cids into needed listeners.
 */
export function getNeededCommandChannelIds(
  context: CommandContext,
  _configId: number,
  _sid: number,
): number[] {
  return [];
}

/** Move a bot to the requesting channel before playback and refresh its mappings. */
export async function joinChannelForCommand(
  context: CommandContext,
  botId: number,
  bot: VoiceBot,
  userClid: number,
): Promise<void> {
  const channelId = context.activeReplyChannel.get(`${botId}:${userClid}`);
  if (!channelId || channelId <= 0) return;
  if (bot.getCurrentChannelId() === channelId) return;

  try {
    bot.joinChannel(channelId);
    console.log(
      `[MusicCmd] Bot ${botId}: joined channel ${channelId} for command from clid=${userClid}`,
    );
    await context.refreshBotChannels(botId);
  } catch (err: any) {
    console.warn(`[MusicCmd] Bot ${botId}: could not join channel ${channelId}: ${err.message}`);
  }
}

/**
 * Idle = no other *human* clients in the bot's channel (sibling music bots do not count).
 * Prefer a ServerQuery clientlist snapshot (accurate after join/move); fall back to
 * the voice client's peer set. Unknown homeCid → try learn from clientlist; if still
 * unknown, treat as idle so bare !here does not falsely report "all busy".
 */
export async function isBotIdleForSummon(
  context: CommandContext,
  bot: VoiceBot,
  serverConfigId: number,
  virtualServerId: number,
): Promise<boolean> {
  let homeCid = bot.getCurrentChannelId();
  if (homeCid <= 0 && context.eventBridge) {
    try {
      const raw = await context.eventBridge.executeCommand(
        serverConfigId,
        virtualServerId,
        'clientlist',
      );
      await context.absorbHomeChannelsFromClientList(serverConfigId, virtualServerId, raw);
      homeCid = bot.getCurrentChannelId();
    } catch {
      /* flood / timeout — fall through */
    }
  }
  if (homeCid <= 0) return true;

  const musicClids = context.musicBotClidsOnServer(serverConfigId, virtualServerId);
  const fromList = await context.countHumanPeersViaClientList(
    serverConfigId,
    virtualServerId,
    homeCid,
    musicClids,
  );
  if (fromList != null) return fromList === 0;

  try {
    const peers = bot.getHumanChannelPeerClids();
    const humans = peers.filter((clid) => !musicClids.has(clid));
    return humans.length === 0;
  } catch {
    try {
      return bot.getHumanChannelPeerCount() === 0;
    } catch {
      return true;
    }
  }
}

/**
 * TS client IDs for music bots on this virtual server that still have a live voice session.
 * Discarded/disconnected bots can leave a leftover `ts3ClientId`; that clid may later be
 * reused by a human, so only exclude clids while the bot is actually connected.
 */
export function musicBotClidsOnServer(
  context: CommandContext,
  serverConfigId: number,
  virtualServerId: number,
): Set<number> {
  const clids = new Set<number>();
  for (const [botId, cfg] of context.botChannelConfig) {
    if (cfg.serverConfigId !== serverConfigId || cfg.virtualServerId !== virtualServerId) {
      continue;
    }
    const b = context.voiceBotManager.getBot(botId);
    // Include starting/reconnect so helper park does not treat the bot as a human.
    if (!b || b.status === 'stopped' || b.status === 'error') continue;
    const clid = b.ts3ClientId || 0;
    if (clid > 0) clids.add(clid);
  }
  return clids;
}

/**
 * Returns human (non-query, non-music-bot) clients in channel, or null if unknown.
 * `excludeClids` should include all known music-bot voice clids on this server.
 */
export async function countHumanPeersViaClientList(
  context: CommandContext,
  configId: number,
  sid: number,
  channelId: number,
  excludeClids: Set<number>,
): Promise<number | null> {
  if (!context.eventBridge || channelId <= 0) return null;
  try {
    const raw = await context.eventBridge.executeCommand(configId, sid, 'clientlist');
    const { parseQueryResponse } = await import('@ts6/common');
    let count = 0;
    for (const line of raw.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('error ')) continue;
      for (const entry of parseQueryResponse(trimmed)) {
        const cid = parseInt(entry.cid || '0', 10);
        const clid = parseInt(entry.clid || '0', 10);
        if (cid !== channelId || !clid || excludeClids.has(clid)) continue;
        if (String(entry.client_type || '0') === '1') continue;
        count++;
      }
    }
    return count;
  } catch (err: any) {
    console.warn(
      `[MusicCmd] clientlist occupancy check failed for ${configId}:${sid} cid=${channelId}: ${err.message}`,
    );
    return null;
  }
}

/**
 * True when the main EventBridge SSH helper is parked in this cid.
 * Connected main SSH alone is not enough — it only hears chat where it sits.
 */
export function sshHelperOwnsChannel(
  context: CommandContext,
  configId: number,
  sid: number,
  channelId: number,
): boolean {
  if (channelId <= 0 || !context.eventBridge) return false;
  if (!context.eventBridge.isConnected(configId, sid)) return false;
  try {
    return context.eventBridge.getMainHelperChannelId(configId, sid) === channelId;
  } catch {
    return false;
  }
}

/**
 * Resolve the channel the user typed in.
 * Order: hint → voice home → voice ensureHome (no SSH) → SSH invoker clientlist.
 */
export async function resolveCommandChannelId(
  context: CommandContext,
  botId: number,
  bot: VoiceBot,
  userClid: number,
  hintChannelId?: number,
): Promise<number> {
  if (hintChannelId && hintChannelId > 0) return hintChannelId;

  const homeBefore = bot.getCurrentChannelId();
  if (homeBefore > 0) return homeBefore;

  if (typeof bot.ensureHomeChannelDiscovered === 'function') {
    const voiceHome = await bot.ensureHomeChannelDiscovered();
    if (voiceHome > 0) return voiceHome;
  }

  const cfg = context.botChannelConfig.get(botId);
  if (!cfg || !context.eventBridge || userClid <= 0) return bot.getCurrentChannelId() || 0;

  try {
    const raw = await context.eventBridge.executeCommand(
      cfg.serverConfigId,
      cfg.virtualServerId,
      'clientlist',
    );
    // Learn bot homes for later idle/summon checks, but for THIS message prefer the
    // invoker channel — absorb must not turn a homeCid=0 voice path into "reply at bot home".
    await context.absorbHomeChannelsFromClientList(
      cfg.serverConfigId,
      cfg.virtualServerId,
      raw,
    );

    const { parseQueryResponse } = await import('@ts6/common');
    for (const line of raw.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('error ')) continue;
      for (const entry of parseQueryResponse(trimmed)) {
        const clid = parseInt(entry.clid || '0', 10);
        if (clid !== userClid) continue;
        const cid = parseInt(entry.cid || entry.client_channel_id || '0', 10);
        if (cid > 0) return cid;
      }
    }
  } catch (err: any) {
    console.warn(
      `[MusicCmd] Invoker channel lookup failed for bot=${botId} clid=${userClid}: ${err.message}`,
    );
  }
  return bot.getCurrentChannelId() || 0;
}

/**
 * A chat music command is an explicit request on this bot, so it may replace
 * this bot's own video stream (VoiceBot records `replaced_by_music`).
 */
export function chatMusicSwitch(context: CommandContext, bot: VoiceBot): { replaceSessionIds: string[] } {
  const video = bot.videoSessionInfo();
  return { replaceSessionIds: video ? [video.id] : [] };
}

/**
 * A chat stream command may replace this bot's own music, but never another
 * bot's stream — that must be stopped first (or switched from the web UI).
 */
export function chatVideoSwitch(context: CommandContext, bot: VoiceBot): { replaceSessionIds: string[] } {
  const music = bot.musicSessionInfo();
  return { replaceSessionIds: music ? [music.id] : [] };
}
