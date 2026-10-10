import { loadPublicUrl } from '../../utils/app-settings.js';
import { resolveMediaIdentity, listHumanMediaListeners } from '../media-listeners.js';
import type { VoiceBot } from '../voice-bot.js';
import type { CommandContext } from './context.js';
import { tryClaimChatInfoReply } from './dedupe.js';
import { createHash } from 'node:crypto';
import { runRemoteAudited } from '../../audit/index.js';
import { AppError } from '../../middleware/error-handler.js';

// Invalidate pending issuance as well as already issued grants on a leave/rejoin.
const revisions = new WeakMap<CommandContext, { value: number }>();
function revisionState(context: CommandContext): { value: number } {
  let state = revisions.get(context);
  if (!state) { state = { value: 0 }; revisions.set(context, state); }
  return state;
}

/** Revoke on departure notifications even if the user returns before the next HTTP request. */
export function revokeDepartedRemote(
  context: CommandContext, configId: number, sid: number, eventName: string, data: Record<string, string>,
): void {
  if (eventName !== 'notifyclientleftview' && eventName !== 'notifyclientmoved') return;
  const clid = Number(data.clid);
  if (!Number.isSafeInteger(clid) || clid <= 0) return;
  revisionState(context).value++;
  context.listenerRemote?.revokeClient(configId, sid, clid);
  // A bot moving away also expires every listener's access to that bot.
  for (const [botId, cfg] of context.botChannelConfig) {
    if (cfg.serverConfigId === configId && cfg.virtualServerId === sid
      && context.voiceBotManager.getBot(botId)?.ts3ClientId === clid) {
      context.listenerRemote?.revoke(botId);
    }
  }
}

function connected(bot: VoiceBot): boolean {
  return ['connected', 'playing', 'paused'].includes(bot.status);
}

/** Issue only to a live, verified human listener, and always send the result privately. */
export async function handleListenerRemote(
  context: CommandContext, botId: number, bot: VoiceBot, clid: number, expectedUid?: string,
): Promise<void> {
  const configId = bot.currentConfig.serverConfigId;
  const config = context.botChannelConfig.get(botId);
  const sid = config?.virtualServerId;
  if (!sid || !tryClaimChatInfoReply(configId, sid, 0, clid, 'remote-private')) return;
  const reply = (message: string) => {
    if (bot.floodHoldActive) return;
    try { bot.sendTextMessage(clid, message); }
    catch { console.warn('[MusicCmd] Private listener remote reply failed'); }
  };
  try {
    if (!context.listenerRemote || !context.eventBridge || !expectedUid || !connected(bot)
      || config?.serverConfigId !== configId || !Number.isSafeInteger(sid) || sid <= 0) {
      reply('Listener remote needs a verified listener in the bot channel.');
      return;
    }
    const state = revisionState(context), revision = state.value;
    const channelId = bot.getCurrentChannelId();
    const { publicUrl } = await loadPublicUrl(context.prisma);
    if (!publicUrl) { reply('Listener remote is unavailable: an admin must configure Public URL.'); return; }
    const url = new URL(publicUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && process.env.NODE_ENV !== 'production')) {
      reply('Listener remote requires an HTTPS Public URL.');
      return;
    }
    const query = (command: string) => context.eventBridge!.executeCommand(configId, sid, command);
    const identity = await resolveMediaIdentity(query, clid, expectedUid);
    const excluded = context.musicBotClidsOnServer(configId, sid);
    excluded.add(bot.ts3ClientId);
    const listeners = identity ? await listHumanMediaListeners(query, channelId, excluded) : null;
    if (!identity || !listeners?.some(peer => peer.clid === clid && peer.uid === identity.uid)
      || bot.getCurrentChannelId() !== channelId || !connected(bot)
      || state.value !== revision) {
      reply('Listener remote needs a verified listener in the bot channel.');
      return;
    }
    if (bot.floodHoldActive) { bot.noteIgnoredCommand(); return; }
    await runRemoteAudited(context.prisma, {
      actor: { id: 0, username: `listener:${createHash('sha256').update(identity.uid).digest('hex')}` },
      action: 'listener.remote.issue', connectionId: configId, virtualServerId: sid,
      target: { type: 'music_bot', id: botId },
    }, async () => {
      // The pending audit write yields: invalidate a leave/rejoin or bot move in that gap.
      if (state.value !== revision || bot.getCurrentChannelId() !== channelId || !connected(bot)) {
        throw new AppError(401, 'Listener remote access expired');
      }
      if (bot.floodHoldActive) { bot.noteIgnoredCommand(); throw new AppError(429, 'TeamSpeak flood hold'); }
      const grant = context.listenerRemote!.issue({ botId, serverConfigId: configId, virtualServerId: sid, channelId, clid, uid: identity.uid });
      // Delivery stays in this synchronous section; audit completion must not delay it.
      reply(`Your private one-time listener remote link: ${publicUrl}/remote#token=${grant.token}`);
    });
  } catch {
    // Query/service errors may contain command text or credentials: never echo them.
    reply('Listener remote is unavailable right now. Try again shortly.');
  }
}
