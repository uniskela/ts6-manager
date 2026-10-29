/**
 * @discordjs/voice 0.19.2 passes audio through unencrypted when a channel is not on DAVE
 * (protocolVersion 0), in both directions. The bridge requires DAVE, so it checks the live
 * session itself and fails closed.
 */
export interface DaveInfo {
  protocolVersion: number;
  ready: boolean;
}

interface MaybeVoiceConnection {
  state?: {
    status?: string;
    networking?: { state?: { code?: number; dave?: { protocolVersion?: number; session?: { ready?: boolean } } } };
  };
}

const NETWORKING_READY = 4;

export function readDaveInfo(connection: MaybeVoiceConnection): DaveInfo | null {
  const st = connection.state;
  if (st?.status !== "ready") return null;
  const net = st.networking?.state;
  if (net?.code !== NETWORKING_READY || !net.dave) return null;
  return { protocolVersion: net.dave.protocolVersion ?? 0, ready: net.dave.session?.ready === true };
}

export function daveEnforced(info: DaveInfo | null): boolean {
  return info !== null && info.protocolVersion >= 1 && info.ready;
}
