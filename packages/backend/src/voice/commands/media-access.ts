import { mediaCommandGroup } from '@ts6/common';
import { loadMediaCommandPermissions, authorizeMediaCommand } from '../media-command-permissions.js';
import { resolveMediaIdentity, listHumanMediaListeners, VoteSkip } from '../media-listeners.js';
import type { VoiceBot } from '../voice-bot.js';
import type { CommandContext } from './context.js';
import { tryClaimChatInfoReply } from './dedupe.js';

const votes = new VoteSkip();

async function mediaScope(context: CommandContext, bot: VoiceBot) {
  const mapped = context.botChannelConfig.get(bot.currentConfig.id);
  const config = mapped ?? await context.prisma.musicBot.findUnique({
    where: { id: bot.currentConfig.id }, select: { serverConfigId: true, virtualServerId: true },
  });
  if (!config || config.serverConfigId !== bot.currentConfig.serverConfigId
    || !Number.isSafeInteger(config.virtualServerId) || config.virtualServerId <= 0) {
    throw new Error('Media server scope is unavailable');
  }
  return { configId: config.serverConfigId, sid: config.virtualServerId };
}

function privateReply(context: CommandContext, bot: VoiceBot, clid: number, message: string): void {
  if (bot.floodHoldActive) return;
  const configId = bot.currentConfig.serverConfigId;
  const sid = context.virtualServerIdForBot(bot.currentConfig.id);
  if (!tryClaimChatInfoReply(configId, sid, 0, clid, 'media-private')) return;
  try {
    bot.sendTextMessage(clid, message);
  } catch (err: any) {
    console.warn(`[MusicCmd] Private media reply failed: ${err.message}`);
  }
}

/** The shared dispatcher gate runs before any media side effect, including cross-channel summons. */
export async function checkMediaCommand(
  context: CommandContext, bot: VoiceBot, clid: number, command: string, args: string, expectedUid?: string,
): Promise<boolean> {
  if (bot.floodHoldActive) {
    bot.noteIgnoredCommand();
    return false;
  }
  const group = mediaCommandGroup(command, args);
  if (group === 'info' || group === 'listener') return true;
  try {
    const { configId, sid } = await mediaScope(context, bot);
    const policy = await loadMediaCommandPermissions(context.prisma, configId, sid);
    // Everyone (and read-only forms) works without a Query identity lookup on upgrades.
    if (authorizeMediaCommand(policy, command, {}, args)) return true;
    const identity = context.eventBridge
      ? await resolveMediaIdentity(cmd => context.eventBridge!.executeCommand(configId, sid, cmd), clid, expectedUid)
      : null;
    if (identity && authorizeMediaCommand(policy, command, identity, args)) return true;
  } catch {
    // A failed settings or identity lookup must not grant media rights.
  }
  privateReply(context, bot, clid, 'You are not allowed to use this command.');
  return false;
}

export async function handleVoteSkip(
  context: CommandContext, bot: VoiceBot, clid: number, expectedUid?: string,
): Promise<void> {
  const token = bot.playbackToken;
  if (!bot.nowPlaying || !token) {
    privateReply(context, bot, clid, 'Nothing is playing.');
    return;
  }
  let scope;
  try { scope = await mediaScope(context, bot); } catch {
    privateReply(context, bot, clid, 'Could not verify listeners right now.');
    return;
  }
  const { configId, sid } = scope;
  const excluded = context.musicBotClidsOnServer(configId, sid);
  excluded.add(bot.ts3ClientId);
  const channelId = bot.getCurrentChannelId();
  const listeners = context.eventBridge
    ? await listHumanMediaListeners(cmd => context.eventBridge!.executeCommand(configId, sid, cmd), channelId, excluded)
    : null;
  if (bot.floodHoldActive || bot.playbackToken !== token || bot.getCurrentChannelId() !== channelId || !bot.nowPlaying) return;
  const voter = listeners?.find(peer => peer.clid === clid && (!expectedUid || peer.uid === expectedUid));
  if (!voter) {
    privateReply(context, bot, clid, 'Vote-skip needs a verified listener in the bot channel.');
    return;
  }
  const result = votes.vote(bot, token, voter.uid, listeners!.map(peer => peer.uid))!;
  if (result.passed) {
    await context.handleSkip(bot, clid);
  } else {
    privateReply(context, bot, clid, `Vote-skip: ${result.votes}/${result.required} votes needed.`);
  }
}
