import type { VoiceBot } from '../voice-bot.js';
import type { CommandContext } from './context.js';
import { checkMediaCommand } from './media-access.js';
import { isBotSummonable } from './channel-ownership.js';
import { hereActionKey, claimHereAction, shouldSpeakHereList } from './dedupe.js';

/** List connected summon candidates on a configured server and virtual server. */
export async function listSummonableBots(
  context: CommandContext,
  serverConfigId: number,
  virtualServerId: number,
): Promise<Array<{ id: number; name: string; bot: VoiceBot }>> {
  const dbBots = await context.prisma.musicBot.findMany({
    where: { serverConfigId },
    select: { id: true, name: true, nickname: true, virtualServerId: true },
    orderBy: { id: 'asc' },
  });

  const result: Array<{ id: number; name: string; bot: VoiceBot }> = [];
  for (const row of dbBots) {
    const sid = row.virtualServerId ?? 1;
    if (sid !== virtualServerId) continue;
    const bot = context.voiceBotManager.getBot(row.id);
    if (!bot || !isBotSummonable(bot)) continue;
    result.push({
      id: row.id,
      name: (row.name || row.nickname || `Bot ${row.id}`).slice(0, 60),
      bot,
    });
  }
  return result;
}

/** Format available or busy summon candidates with current-channel and idle tags. */
export function formatHereBotList(
  context: CommandContext,
  bots: Array<{ id: number; name: string }>,
  opts?: { busy?: boolean; hereIds?: Set<number>; idleIds?: Set<number> },
): string {
  const hereIds = opts?.hereIds;
  const idleIds = opts?.idleIds;
  const lines = bots.map((b) => {
    let tag = '';
    if (hereIds?.has(b.id)) tag = ' (already here)';
    else if (idleIds && !idleIds.has(b.id) && !opts?.busy) tag = ' (busy)';
    return `[${b.id}] ${b.name}${tag}`;
  });
  if (opts?.busy) {
    return (
      `All music bots are busy with other users:\n${lines.join('\n')}\n` +
      `Use !here <id> to move a specific bot (may leave their channel).`
    );
  }
  return `Available bots:\n${lines.join('\n')}\nUse: !here <id>`;
}

/**
 * Non-disruptive summon selection:
 * 1) sole bot already in channel → "already here"
 * 2) one+ already here AND other idle bots elsewhere → list (do not hide the others)
 * 3) idle bots (no other humans); sole idle → summon; several → list
 * 4) otherwise do not auto-steal — caller lists busy bots
 */
export async function resolveSummonCandidate(
  context: CommandContext,
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
  const alreadyHere = candidates.filter((c) => c.bot.getCurrentChannelId() === channelId);
  const idle: Array<{ id: number; name: string; bot: VoiceBot }> = [];
  for (const c of candidates) {
    if (await context.isBotIdleForSummon(c.bot, serverConfigId, virtualServerId)) {
      idle.push(c);
    }
  }
  const idleIds = new Set(idle.map((c) => c.id));
  const hereIds = new Set(alreadyHere.map((c) => c.id));
  const idleElsewhere = idle.filter((c) => !hereIds.has(c.id));

  // One bot already here and nobody else idle to offer → confirm presence.
  if (alreadyHere.length === 1 && idleElsewhere.length === 0 && candidates.length === 1) {
    return { kind: 'summon', target: alreadyHere[0] };
  }
  // Someone is here but other idle bots exist — list so the user can pick.
  if (alreadyHere.length >= 1 && idleElsewhere.length > 0) {
    return {
      kind: 'list',
      bots: [...alreadyHere, ...idleElsewhere],
      busy: false,
      hereIds,
      idleIds,
    };
  }
  if (alreadyHere.length > 1 && idleElsewhere.length === 0) {
    return { kind: 'list', bots: alreadyHere, busy: false, hereIds, idleIds };
  }
  // Sole already-here among busy-only others → confirm; user can !here <id> to steal.
  if (alreadyHere.length === 1 && idleElsewhere.length === 0) {
    return { kind: 'summon', target: alreadyHere[0] };
  }

  if (idle.length === 1) {
    return { kind: 'summon', target: idle[0] };
  }
  if (idle.length > 1) {
    return { kind: 'list', bots: idle, busy: false, idleIds };
  }

  return { kind: 'list', bots: candidates, busy: true };
}

/** Announce a summon before moving the bot and refreshing its channel mappings. */
export async function summonBotToChannel(
  context: CommandContext,
  target: { id: number; name: string; bot: VoiceBot },
  channelId: number,
  replyBot: VoiceBot,
  userClid: number,
): Promise<void> {
  if (!channelId || channelId <= 0) {
    await context.reply(replyBot, userClid, 'Could not determine this channel.');
    return;
  }

  if (target.bot.getCurrentChannelId() === channelId) {
    await context.reply(
      replyBot,
      userClid,
      `${target.name} [#${target.id}] is already here.`,
    );
    return;
  }

  if (!isBotSummonable(target.bot) || !target.bot.ts3ClientId) {
    await context.reply(
      replyBot,
      userClid,
      `Could not move ${target.name} [#${target.id}]: bot is not fully connected.`,
    );
    return;
  }

  // Announce *before* joinChannel / refreshBotChannels. joinChannel
  // optimistically sets currentChannelId, and refresh disconnects the SSH
  // command-channel listener once that channel looks like "home" — so a
  // post-move reply often never reaches the channel where the user typed.
  await context.reply(
    replyBot,
    userClid,
    `${target.name} [#${target.id}] is joining.`,
  );

  try {
    target.bot.joinChannel(channelId);
    if (target.bot.getCurrentChannelId() !== channelId) {
      await context.reply(
        replyBot,
        userClid,
        `Could not move ${target.name} [#${target.id}]: move did not apply.`,
      );
      return;
    }
    console.log(
      `[MusicCmd] Bot ${target.id}: summoned to channel ${channelId} by clid=${userClid}`,
    );
    await context.refreshBotChannels(target.id);
  } catch (err: any) {
    console.warn(`[MusicCmd] Bot ${target.id}: summon failed: ${err.message}`);
    await context.reply(
      replyBot,
      userClid,
      `Could not move ${target.name} [#${target.id}]: ${err.message}`,
    );
  }
}

/** Deduplicate a voice summon, select a bot or list candidates, and announce before moving. */
export async function handleHere(
  context: CommandContext,
  botId: number,
  bot: VoiceBot,
  userClid: number,
  args: string,
): Promise<void> {
  const cfg = context.botChannelConfig.get(botId);
  const serverConfigId = cfg?.serverConfigId ?? bot.currentConfig.serverConfigId;
  const virtualServerId = cfg?.virtualServerId ?? 1;
  const hinted =
    context.activeReplyChannel.get(`${botId}:${userClid}`) ||
    bot.getCurrentChannelId() ||
    0;
  const channelId = await context.resolveCommandChannelId(
    botId,
    bot,
    userClid,
    hinted > 0 ? hinted : undefined,
  );

  if (channelId > 0) {
    context.activeReplyChannel.set(`${botId}:${userClid}`, channelId);
  }

  // Unknown command channel → do not claim with cid=0 (would miss SSH dedupe).
  // Soft notice unless the main helper is parked in this channel (connected
  // main SSH alone is not enough — need ensureHelperInChannel park).
  if (channelId <= 0) {
    console.warn(
      `[MusicCmd] !here skipped on voice bot=${botId}: unknown channel (homeCid=${bot.getCurrentChannelId()})`,
    );
    if (context.sshHelperOwnsChannel(serverConfigId, virtualServerId, channelId)) return;
    const softKey = hereActionKey(serverConfigId, virtualServerId, 0, userClid, `unknown:${args}`);
    if (!claimHereAction(softKey)) return;
    try {
      bot.sendChannelMessage(
        'Could not determine this channel yet. Wait a second and try !here again.',
      );
    } catch (err: any) {
      console.warn(`[MusicCmd] !here unknown-channel notice failed: ${err.message}`);
    }
    return;
  }

  if (
    !claimHereAction(hereActionKey(serverConfigId, virtualServerId, channelId, userClid, args))
  ) {
    console.log(
      `[MusicCmd] !here deduped (bot=${botId} cid=${channelId} clid=${userClid} args=${JSON.stringify(args)})`,
    );
    return;
  }

  const candidates = await context.listSummonableBots(serverConfigId, virtualServerId);
  if (candidates.length === 0) {
    await context.reply(bot, userClid, 'No music bots are available right now.');
    return;
  }

  if (!args) {
    if (candidates.length === 1) {
      await context.summonBotToChannel(candidates[0], channelId, bot, userClid);
      return;
    }
    const resolved = await context.resolveSummonCandidate(
      candidates,
      channelId,
      serverConfigId,
      virtualServerId,
    );
    if (resolved.kind === 'summon') {
      await context.summonBotToChannel(resolved.target, channelId, bot, userClid);
      return;
    }
    if (!context.shouldSpeakHereList(serverConfigId, virtualServerId, channelId, userClid)) {
      console.log(
        `[MusicCmd] !here list suppressed by cooldown (config=${serverConfigId} cid=${channelId} clid=${userClid})`,
      );
      return;
    }
    await context.reply(
      bot,
      userClid,
      context.formatHereBotList(resolved.bots, {
        busy: resolved.busy,
        hereIds: resolved.hereIds,
        idleIds: resolved.idleIds,
      }),
    );
    return;
  }

  const targetId = parseInt(args, 10);
  if (isNaN(targetId) || String(targetId) !== args.trim()) {
    await context.reply(bot, userClid, 'Usage: !here [id] — Use !here to list bots.');
    return;
  }

  const target = candidates.find((c) => c.id === targetId);
  if (!target) {
    await context.reply(
      bot,
      userClid,
      `Bot #${targetId} is not available. Use !here to list bots.`,
    );
    return;
  }

  // Explicit id = intentional, even if the bot is busy with other users.
  await context.summonBotToChannel(target, channelId, bot, userClid);
}

/** Cross-channel !here: list/summon any running bot on this virtual server. */
export async function handleHereCrossChannel(
  context: CommandContext,
  configId: number,
  sid: number,
  channelId: number,
  data: Record<string, string>,
  args: string,
): Promise<void> {
  const userClid = parseInt(data.invokerid || '0', 10);
  if (!userClid) {
    console.warn(
      `[MusicCmd] Cross-channel !here ignored: missing invokerid (cid=${channelId})`,
    );
    return;
  }

  if (channelId <= 0) {
    console.warn(`[MusicCmd] Cross-channel !here ignored: invalid cid=${channelId}`);
    return;
  }

  if (!claimHereAction(hereActionKey(configId, sid, channelId, userClid, args))) {
    console.log(
      `[MusicCmd] Cross-channel !here deduped (cid=${channelId} clid=${userClid} args=${JSON.stringify(args)})`,
    );
    return;
  }

  console.log(
    `[MusicCmd] Cross-channel !here ${args} (config=${configId} sid=${sid} cid=${channelId} clid=${userClid})`,
  );

  const candidates = await context.listSummonableBots(configId, sid);
  if (candidates.length === 0) {
    const noneMsg = 'No music bots are available right now.';
    if (context.eventBridge) {
      const ok = await context.eventBridge.sendChannelText(
        configId,
        sid,
        channelId,
        noneMsg,
        { helperNickname: 'TS6 Helper' },
      );
      if (!ok) {
        console.warn(
          `[MusicCmd] !here: no summonable bots; failed to reply in cid=${channelId}`,
        );
      }
    } else {
      console.warn(
        `[MusicCmd] !here: no summonable bots and no eventBridge to reply (cid=${channelId})`,
      );
    }
    return;
  }

  const replyBot = candidates[0].bot;
  if (!await checkMediaCommand(context, replyBot, userClid, 'here', args, data.invokeruid)) return;
  // Route replies through a summonable bot while tagging the command channel.
  context.activeReplyChannel.set(`${replyBot.currentConfig.id}:${userClid}`, channelId);
  try {
    if (!args) {
      if (candidates.length === 1) {
        await context.summonBotToChannel(candidates[0], channelId, replyBot, userClid);
        return;
      }
      const resolved = await context.resolveSummonCandidate(
        candidates,
        channelId,
        configId,
        sid,
      );
      if (resolved.kind === 'summon') {
        await context.summonBotToChannel(resolved.target, channelId, replyBot, userClid);
        return;
      }
      if (!context.shouldSpeakHereList(configId, sid, channelId, userClid)) {
        console.log(
          `[MusicCmd] Cross-channel !here list suppressed by cooldown (cid=${channelId} clid=${userClid})`,
        );
        return;
      }
      await context.reply(
        replyBot,
        userClid,
        context.formatHereBotList(resolved.bots, {
          busy: resolved.busy,
          hereIds: resolved.hereIds,
          idleIds: resolved.idleIds,
        }),
      );
      return;
    }

    const targetId = parseInt(args, 10);
    if (isNaN(targetId) || String(targetId) !== args.trim()) {
      await context.reply(replyBot, userClid, 'Usage: !here [id] — Use !here to list bots.');
      return;
    }

    const target = candidates.find((c) => c.id === targetId);
    if (!target) {
      await context.reply(
        replyBot,
        userClid,
        `Bot #${targetId} is not available. Use !here to list bots.`,
      );
      return;
    }

    await context.summonBotToChannel(target, channelId, replyBot, userClid);
  } finally {
    context.activeReplyChannel.delete(`${replyBot.currentConfig.id}:${userClid}`);
  }
}
