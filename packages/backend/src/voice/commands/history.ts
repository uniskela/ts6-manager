import type { VoiceBot } from '../voice-bot.js';
import type { CommandContext } from './context.js';
import {
  MEDIA_UNAVAILABLE, PUBLIC_MUSIC_REQUEST_SELECT, markMusicRequestUnavailable,
  isUnavailableMusicRequestError, musicRequestListWhere, pruneMusicRequests, replayReference,
} from '../music-request-history.js';
import { beginChatMediaRequest, enqueueMediaItem } from './queue.js';

// Metadata is untrusted and must not add chat markup, links, or extra lines.
function historyText(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('[', '&#91;').replaceAll(']', '&#93;').replace(/([\\*_`~|()])/g, String.raw`\$1`);
}

export async function handleHistory(
  context: CommandContext, botId: number, bot: VoiceBot, userClid: number, args: string,
): Promise<void> {
  if (args) { await context.reply(bot, userClid, 'Usage: !history'); return; }
  const serverConfigId = bot.currentConfig.serverConfigId;
  const virtualServerId = context.virtualServerIdForBot(botId);
  await pruneMusicRequests(context.prisma, serverConfigId, 0);
  const rows = await context.prisma.musicRequest.findMany({
    where: musicRequestListWhere(serverConfigId, botId),
    select: PUBLIC_MUSIC_REQUEST_SELECT,
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: 10,
  });
  if (context.voiceBotManager.getBot(botId) !== bot || bot.currentConfig.serverConfigId !== serverConfigId
    || context.virtualServerIdForBot(botId) !== virtualServerId) return;
  await context.reply(bot, userClid, rows.length
    ? ['Recent requests:', ...rows.map(row =>
      `#${row.id} ${historyText(row.title, 70)} — ${historyText(row.source, 20)} — ${row.requestedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC${row.status === 'unavailable' ? ' (unavailable)' : ''}`),
    'Use !again <id>, or !again for the latest request.'].join('\n')
    : 'No request history for this bot yet.');
}

export async function handleAgain(
  context: CommandContext, botId: number, bot: VoiceBot, userClid: number, args: string,
): Promise<void> {
  if (args && (!/^[1-9]\d*$/.test(args) || !Number.isSafeInteger(Number(args)))) {
    await context.reply(bot, userClid, 'Usage: !again [id]'); return;
  }
  const serverConfigId = bot.currentConfig.serverConfigId;
  const virtualServerId = context.virtualServerIdForBot(botId);
  const request = beginChatMediaRequest(botId);
  const isCurrent = () => !request.isCancelled() && context.voiceBotManager.getBot(botId) === bot
    && bot.currentConfig.serverConfigId === serverConfigId
    && context.virtualServerIdForBot(botId) === virtualServerId;
  const config = await context.prisma.musicBot.findUnique({ where: { id: botId }, select: { serverConfigId: true, virtualServerId: true } });
  if (!isCurrent()) return;
  if (config?.serverConfigId !== serverConfigId || config?.virtualServerId !== virtualServerId) {
    await context.reply(bot, userClid, 'Bot config not found.'); return;
  }
  const row = await context.prisma.musicRequest.findFirst({
    where: { ...musicRequestListWhere(serverConfigId, botId), ...(args ? { id: Number(args) } : {}) },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
  });
  if (!isCurrent()) return;
  if (!row) { await context.reply(bot, userClid, 'Request not found. Use !history to list requests.'); return; }
  const ref = await replayReference(row);
  if (!isCurrent()) return;
  if (!ref.ok) {
    await markMusicRequestUnavailable(context.prisma, row.id);
    if (isCurrent()) await context.reply(bot, userClid, MEDIA_UNAVAILABLE);
    return;
  }
  try {
    if (ref.kind === 'url') {
      await context.enqueueMediaUrl(botId, bot, userClid, ref.url, request);
      return;
    }
    await context.joinChannelForCommand(botId, bot, userClid);
    if (!isCurrent()) return;
    const item = ref.kind === 'local'
      ? { id: `history_${row.id}`, title: row.title, artist: row.artist ?? undefined, duration: row.duration ?? undefined, source: 'local' as const, filePath: ref.filePath }
      : { id: `history_${row.id}`, title: row.title, artist: row.artist ?? undefined, source: 'radio' as const, filePath: '', streamUrl: ref.url };
    const queued = await enqueueMediaItem(context, bot, item, isCurrent);
    if (queued !== null && isCurrent()) await context.reply(bot, userClid, `${queued ? 'Queued' : 'Now playing'}: ${historyText(row.title, 70)}`);
  } catch (error) {
    if (!isCurrent()) return;
    if (!isUnavailableMusicRequestError(error)) throw error;
    await markMusicRequestUnavailable(context.prisma, row.id);
    if (isCurrent()) await context.reply(bot, userClid, MEDIA_UNAVAILABLE);
  }
}
