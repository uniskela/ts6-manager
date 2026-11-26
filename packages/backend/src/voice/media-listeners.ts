import { parseQueryResponse } from '@ts6/common';

/** The same scoped TeamSpeak Query transport can serve chat and a future remote. */
export type MediaQuery = (command: string) => Promise<string>;
export interface MediaIdentity {
  uid: string;
  serverGroupIds: number[];
  /** Current TeamSpeak channel id from the same clientinfo row. */
  channelId: number;
}

function queryEntries(raw: string): Record<string, string>[] {
  return raw.split(/\r?\n/).flatMap(line => {
    if (line.startsWith('error ')) {
      if (!/^error id=0(?:\s|$)/.test(line)) throw new Error('TeamSpeak lookup refused');
      return [];
    }
    return line.trim() ? parseQueryResponse(line.trim()) : [];
  });
}

/** Resolve membership from the server; a reused clid must never inherit an old UID's rights. */
export async function resolveMediaIdentity(
  query: MediaQuery,
  clid: number,
  expectedUid?: string,
): Promise<MediaIdentity | null> {
  if (!Number.isSafeInteger(clid) || clid <= 0) return null;
  try {
    const [entry] = queryEntries(await query(`clientinfo clid=${clid}`));
    if (!entry) return null;
    const uid = entry.client_unique_identifier;
    const groups = entry.client_servergroups;
    const channelId = Number(entry.cid);
    const reportedClid = Number(entry.clid);
    // Authoritative row must be a human client in a real channel; refuse query/bots and
    // stale clid reuse when TeamSpeak echoes a different clid on the same response.
    if (!uid || (expectedUid && uid !== expectedUid) || entry.client_type !== '0') return null;
    if (entry.clid !== undefined && entry.clid !== '' && reportedClid !== clid) return null;
    if (!groups || !/^\d+(?:,\d+)*$/.test(groups)) return null;
    if (!Number.isSafeInteger(channelId) || channelId <= 0) return null;
    const serverGroupIds = groups.split(',').map(Number);
    if (serverGroupIds.some(id => !Number.isSafeInteger(id) || id <= 0)) return null;
    return { uid, serverGroupIds, channelId };
  } catch {
    return null;
  }
}

/** Current channel electorate: non-query clients with identities, excluding managed voice bots. */
export async function listHumanMediaListeners(
  query: MediaQuery,
  channelId: number,
  botClids: ReadonlySet<number>,
): Promise<Array<{ clid: number; uid: string }> | null> {
  if (channelId <= 0) return null;
  try {
    const listeners: Array<{ clid: number; uid: string }> = [];
    for (const entry of queryEntries(await query('clientlist -uid'))) {
      const clid = Number(entry.clid);
      if (Number(entry.cid) !== channelId || !Number.isSafeInteger(clid) || clid <= 0 || entry.client_type !== '0' || botClids.has(clid)) continue;
      const uid = entry.client_unique_identifier;
      // Missing identities must not shrink the human electorate and lower the majority.
      if (!uid) return null;
      listeners.push({ clid, uid });
    }
    return listeners;
  } catch {
    return null;
  }
}

/** One electorate and one skip claim per playback token, including replay of the same queue item. */
export class VoteSkip {
  private tracks = new WeakMap<object, { token: object; voters: Set<string>; skipped: boolean }>();

  vote(bot: object, token: object, uid: string, listenerUids: readonly string[]) {
    const listeners = new Set(listenerUids);
    if (!uid || !listeners.has(uid)) return null;
    let track = this.tracks.get(bot);
    if (!track || track.token !== token) {
      track = { token, voters: new Set(), skipped: false };
      this.tracks.set(bot, track);
    }
    for (const voter of track.voters) {
      if (!listeners.has(voter)) track.voters.delete(voter);
    }
    const duplicate = track.voters.has(uid);
    track.voters.add(uid);
    const required = Math.floor(listeners.size / 2) + 1;
    const passed = !track.skipped && track.voters.size >= required;
    if (passed) track.skipped = true;
    return { votes: track.voters.size, required, passed, duplicate };
  }
}
