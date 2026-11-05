import fs from 'node:fs/promises';
import type { BridgeSnapshot } from './adapter.js';

/**
 * Map D1 private-beta / host status JSON (or a future HTTP /health body) into
 * the Discord `/ts bridge` snapshot. Never includes tokens or host addresses.
 */
export function mapDiscordBridgeStatus(raw: unknown): BridgeSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const senders = (o.senders && typeof o.senders === 'object')
    ? o.senders as Record<string, { daveReady?: boolean }>
    : undefined;
  const daveObj = (o.dave && typeof o.dave === 'object')
    ? o.dave as Record<string, { ready?: boolean } | null>
    : undefined;

  let daveReady = false;
  if (typeof o.daveReady === 'boolean') daveReady = o.daveReady;
  else if (senders) {
    daveReady = Object.values(senders).some((s) => s?.daveReady === true);
  } else if (daveObj) {
    daveReady = Object.values(daveObj).some((s) => s?.ready === true);
  }

  const electedSlot = String(
    o.receiver
      ?? o.electedSlot
      ?? o.slot
      ?? 'unknown',
  );
  const generation = Number(o.generation ?? 0);
  if (!Number.isFinite(generation)) return null;

  const t2d = (o.t2d && typeof o.t2d === 'object') ? o.t2d as Record<string, unknown> : undefined;
  const t2dForwarded = typeof o.t2dForwarded === 'number'
    ? o.t2dForwarded
    : typeof t2d?.forwarded === 'number'
      ? t2d.forwarded
      : undefined;

  return {
    daveReady,
    electedSlot,
    generation,
    ...(t2dForwarded != null ? { t2dForwarded } : {}),
  };
}

/**
 * Optional Discord↔TS bridge health for `/ts bridge`.
 * - No URL and no status file → null (honest unavailable; default compose).
 * - Status file (lab) preferred when set.
 * - Otherwise GET `{baseUrl}/health` with Bearer secret when both are configured.
 */
export function createDiscordBridgeHealthPort(opts: {
  baseUrl?: string;
  secret?: string;
  statusFilePath?: string;
  fetchImpl?: typeof fetch;
}): { health(guildId: string): Promise<BridgeSnapshot | null> } {
  let base = (opts.baseUrl || '').trim();
  while (base.endsWith('/')) base = base.slice(0, -1);
  const secret = (opts.secret || '').trim();
  const statusFile = (opts.statusFilePath || '').trim();
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async health(_guildId: string): Promise<BridgeSnapshot | null> {
      if (statusFile) {
        try {
          const text = await fs.readFile(statusFile, 'utf8');
          return mapDiscordBridgeStatus(JSON.parse(text));
        } catch {
          return null;
        }
      }
      if (!base) return null;
      if (!secret) return null;
      try {
        const res = await fetchImpl(`${base}/health`, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${secret}`,
            accept: 'application/json',
          },
        });
        if (!res.ok) return null;
        const body = await res.json();
        return mapDiscordBridgeStatus(body);
      } catch {
        return null;
      }
    },
  };
}
