import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/index.js';
import type { WebQueryClient } from '../ts-client/webquery-client.js';

type Owner = { flowId: number; configId: number; sid: number };
// Separate from user-editable flow variables. One row per channel avoids lost updates.
const scope = (owner: Owner) => `temp-channel:${owner.configId}:${owner.sid}`;

export async function createOwnedTempChannel(
  prisma: PrismaClient, owner: Owner, client: WebQueryClient, params: Record<string, string>,
) {
  if (params.channel_flag_semi_permanent !== '1' || !params.cpid || params.cpid === '0') {
    throw new Error('Tracked temp channels require a parent and the semi-permanent flag');
  }
  const marker = `TS6 Manager temporary channel ${randomUUID()}`;
  const result = await client.executePost(owner.sid, 'channelcreate', {
    ...params, channel_description: marker,
  });
  const cid = String(result?.[0]?.cid ?? '');
  if (!/^[1-9]\d*$/.test(cid)) throw new Error('Channel creation returned no channel ID');
  // If persistence fails, leave the channel untouched: fail closed, never adopt siblings.
  await prisma.botVariable.create({ data: {
    flowId: owner.flowId, scope: scope(owner), name: cid,
    value: JSON.stringify({ parent: params.cpid, marker }),
  } });
  return result;
}

export async function cleanupOwnedTempChannels(
  prisma: PrismaClient, owner: Owner, client: WebQueryClient,
  parent: string, protectedIds: Set<string>,
): Promise<number> {
  const records = await prisma.botVariable.findMany({
    where: { flowId: owner.flowId, scope: scope(owner) },
  });
  const channels = await client.execute(owner.sid, 'channellist');
  if (!Array.isArray(channels)) return 0;
  let deleted = 0;
  for (const record of records) {
    const cid = record.name;
    const forget = () => prisma.botVariable.deleteMany({ where: { id: record.id } });
    const channel = channels.find(ch => String(ch.cid) === cid);
    if (!channel) { await forget(); continue; }
    if (cid === parent || protectedIds.has(cid)) continue;
    let saved: { parent: string; marker: string };
    try { saved = JSON.parse(record.value); } catch { continue; }
    if (saved.parent !== parent || typeof saved.marker !== 'string' || !saved.marker) continue;
    if (String(channel.pid) !== parent || Number(channel.total_clients) !== 0) continue;
    // Do not remove a subtree that may contain administrator-created channels.
    if (channels.some(ch => String(ch.pid) === cid)) continue;
    try {
      const info = (await client.execute(owner.sid, 'channelinfo', { cid }))?.[0];
      // The random marker plus registry guards against IDs reused after a server reset.
      if (!info || info.channel_description !== saved.marker) { await forget(); continue; }
      if (Number(info.channel_flag_semi_permanent) !== 1 || Number(info.channel_flag_permanent) === 1) continue;
      if (String(info.pid) !== parent) continue;
      // Never force: TeamSpeak must reject deletion if a client joined or a child exists.
      await client.executePost(owner.sid, 'channeldelete', { cid, force: 0 });
      await forget();
      deleted++;
    } catch {
      // Occupancy races / transient failures retain ownership for the next attempt.
    }
  }
  return deleted;
}
