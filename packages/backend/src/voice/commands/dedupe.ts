import type { CommandContext } from './context.js';
/** Per bot+user cooldown for custom replies (ms). */
const CHAT_REPLY_COOLDOWN_MS = 2500;
const chatReplyCooldownUntil = new Map<string, number>();

/** Build a reply claim key scoped to server, virtual server, channel, user, and command. */
export function chatInfoReplyKey(
  serverConfigId: number,
  virtualServerId: number,
  channelId: number,
  clid: number,
  command: string,
): string {
  return `${serverConfigId}:${virtualServerId}:${channelId}:${clid}:${command}`;
}

/** Claim the custom/info reply cooldown unless the same scoped command is still held. */
export function tryClaimChatInfoReply(
  serverConfigId: number,
  virtualServerId: number,
  channelId: number,
  clid: number,
  command: string,
): boolean {
  const key = chatInfoReplyKey(serverConfigId, virtualServerId, channelId, clid, command);
  const until = chatReplyCooldownUntil.get(key) ?? 0;
  if (Date.now() < until) return false;
  chatReplyCooldownUntil.set(key, Date.now() + CHAT_REPLY_COOLDOWN_MS);
  return true;
}

/** @internal Exported for unit tests. */
export function resetChatReplyCooldownsForTests(): void {
  chatReplyCooldownUntil.clear();
  helpActionUntil.clear();
  helpFlights.clear();
  hereActionUntil.clear();
  hereListCooldownUntil.clear();
  channelCommandUntil.clear();
}

/** Collapse duplicate !help when several bots hear the same channel message. */
const HELP_ACTION_DEDUP_MS = 2500;
/** Cooldown after a *successful* help post (late arrivals skip). */
const helpActionUntil = new Map<string, number>();
/**
 * In-flight help owners. Waiters await `result`; true = posted, false = failed
 * (waiter may become owner). Prevents mid-send duplicates without silencing voice
 * forever when SSH send fails.
 */
type HelpFlight = {
  result: Promise<boolean>;
  settle: (ok: boolean) => void;
};
const helpFlights = new Map<string, HelpFlight>();

/** Build a help claim key scoped to one server, virtual server, channel, and user. */
export function helpActionKey(
  serverConfigId: number,
  virtualServerId: number,
  channelId: number,
  userClid: number,
): string {
  return `${serverConfigId}:${virtualServerId}:${channelId}:${userClid}`;
}

/**
 * Become help owner, or wait for the current owner.
 * @returns true if this caller should post help; false if another path already posted.
 */
export async function beginHelpAction(key: string): Promise<boolean> {
  for (;;) {
    const until = helpActionUntil.get(key) ?? 0;
    if (Date.now() < until) return false;

    const flight = helpFlights.get(key);
    if (flight) {
      const ok = await flight.result;
      if (ok) return false;
      // Owner failed — loop and try to claim.
      continue;
    }

    let settle!: (ok: boolean) => void;
    const result = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const entry: HelpFlight = { result, settle };
    helpFlights.set(key, entry);
    // Single-threaded: we own the slot we just created.
    if (helpFlights.get(key) === entry) return true;
  }
}

/** Finish an in-flight help attempt. `posted` true keeps a short success cooldown. */
export function completeHelpAction(key: string, posted: boolean): void {
  if (posted) {
    helpActionUntil.set(key, Date.now() + HELP_ACTION_DEDUP_MS);
  }
  const flight = helpFlights.get(key);
  if (!flight) return;
  helpFlights.delete(key);
  flight.settle(posted);
}

/** Collapse duplicate !here lists when several bots hear the same channel message. */
const HERE_LIST_COOLDOWN_MS = 2000;
const hereListCooldownUntil = new Map<string, number>();

/**
 * One chat line can hit SSH cmd-listener and/or several voice bots in the same
 * channel. Claim the summon/list action once so we do not announce+join twice.
 */
const HERE_ACTION_DEDUP_MS = 1500;
const hereActionUntil = new Map<string, number>();

/** Build a summon claim key that includes the requester channel and command arguments. */
export function hereActionKey(
  serverConfigId: number,
  virtualServerId: number,
  channelId: number,
  userClid: number,
  args: string,
): string {
  return `${serverConfigId}:${virtualServerId}:${channelId}:${userClid}:${args}`;
}

/** Returns true if this caller should run the !here action; false if a duplicate. */
export function claimHereAction(key: string): boolean {
  const until = hereActionUntil.get(key) ?? 0;
  if (Date.now() < until) return false;
  hereActionUntil.set(key, Date.now() + HERE_ACTION_DEDUP_MS);
  return true;
}

/** Test helper: clear !here / !help dedupe/list cooldowns between cases. */
export function resetHereDedupForTests(): void {
  hereActionUntil.clear();
  hereListCooldownUntil.clear();
  helpActionUntil.clear();
  helpFlights.clear();
  chatReplyCooldownUntil.clear();
  channelCommandUntil.clear();
}

/** Claim the shorter cooldown used for repeated summon candidate lists. */
export function shouldSpeakHereList(
  context: CommandContext,
  serverConfigId: number,
  virtualServerId: number,
  channelId: number,
  userClid: number,
): boolean {
  const key = `${serverConfigId}:${virtualServerId}:${channelId}:${userClid}`;
  const until = hereListCooldownUntil.get(key) ?? 0;
  if (Date.now() < until) return false;
  hereListCooldownUntil.set(key, Date.now() + HERE_LIST_COOLDOWN_MS);
  return true;
}

/** Collapse one channel command when several bots hear the same chat line. */
const CHANNEL_COMMAND_DEDUP_MS = 1500;
const channelCommandUntil = new Map<string, number>();

/** Build a claim key for one user command line in a channel. */
export function channelCommandKey(
  serverConfigId: number,
  virtualServerId: number,
  channelId: number,
  userClid: number,
  command: string,
  msg: string,
): string {
  return `${serverConfigId}:${virtualServerId}:${channelId}:${userClid}:${command}:${msg}`;
}

/** True when this bot should run the command; false when a peer already claimed it. */
export function claimChannelCommand(key: string): boolean {
  const now = Date.now();
  for (const [claimKey, expiresAt] of channelCommandUntil) {
    if (now >= expiresAt) channelCommandUntil.delete(claimKey);
  }
  const until = channelCommandUntil.get(key) ?? 0;
  if (now < until) return false;
  channelCommandUntil.set(key, now + CHANNEL_COMMAND_DEDUP_MS);
  return true;
}
