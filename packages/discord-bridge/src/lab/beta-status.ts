import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PRIVATE_BETA_MODE = "private-beta" as const;
export const STATUS_FILE = "evidence/private-beta-status.json";
export const HOST_STATUS_FILE = "evidence/host-status.json";
export const EVENT_CAP = 200;

export type BetaHealth = "starting" | "ok" | "degraded" | "unavailable" | "parked" | "fail-closed";
export type BetaEventKind =
  | "starting"
  | "bridge_running"
  | "dave_ready"
  | "dave_lost"
  | "receiver_changed"
  | "generation_changed"
  | "reconnect_scheduled"
  | "unhealthy"
  | "slot_refused"
  | "route_unavailable"
  | "stopping"
  | "stopped";

export interface BetaEvent {
  at: string;
  kind: BetaEventKind;
  /** Slot ids, counters and booleans only. Never tokens, user names, audio or host addresses. */
  detail?: Record<string, string | number | boolean | null>;
}

export interface DaveSlotInfo {
  protocolVersion?: number;
  ready?: boolean;
}

export interface BetaSnapshotIn {
  state?: string;
  receiver?: string | null;
  generation?: number;
  scheduledReconnects?: number;
  duplicateReceivers?: unknown[];
  dave?: Record<string, DaveSlotInfo | null | undefined>;
  decryptErrors?: Record<string, number>;
  daveReplacements?: Record<string, number>;
  recoveries?: Record<string, number>;
  d2t?: { framesSent?: number; daveDropped?: number; admissionDropped?: number; selfSourceDrops?: number };
  t2d?: {
    received?: number;
    forwarded?: number;
    unsupportedFrames?: number;
    invalidFrames?: number;
    decodeErrors?: number;
    voiceStops?: number;
    malformed?: number;
    unknownSpeakers?: number;
    ownVoice?: number;
    excluded?: number;
    notInChannel?: number;
    unavailable?: number;
  };
  tsTransport?: { whisperDropped?: number };
  senders?: Record<
    string,
    {
      daveReady?: boolean;
      framesSent?: number;
      playerStatus?: string;
      playbackDropped?: number;
      playbackStarved?: number;
      playbackHealthRejected?: number;
      playbackDaveRejected?: number;
      healthy?: boolean;
      inChannel?: boolean;
    }
  >;
  /** Discord voice-channel occupancy. Integers only; never user ids. */
  voiceMembers?: number;
  voiceBots?: number;
  /** Same bots-only grant as DAVE idle park (voice-state plus MLS peers). Receiver optional at startup. */
  botsOnlyPark?: boolean;
  refusedSlots?: string[];
  unavailableRoutes?: number;
  occupiedSlots?: number;
  desiredSlots?: string[];
  connectedSlots?: string[];
  recovery?: Record<string, { used?: number; max?: number }>;
  occupancy?: { slot: number; occupied?: boolean; occupant?: string | null; eligible: boolean }[];
}

export type ParkBot = { id: string; knownBotsOnlyChannel: boolean; connected?: boolean };

/** Map DiscordBot-like adapters the way private-beta snapshot does (`voiceConnection !== null`). */
export function connectedParkBots(
  bots: Iterable<{ id: string; knownBotsOnlyChannel: boolean; voiceConnection: unknown }>,
): ParkBot[] {
  return [...bots].map((b) => ({
    id: b.id,
    knownBotsOnlyChannel: b.knownBotsOnlyChannel,
    connected: b.voiceConnection !== null,
  }));
}

/**
 * Park when the elected receiver grants, or when every currently connected bot grants before election.
 * Disconnected bots are not observers. No connected observer, or any connected false, is not a park.
 */
export function botsOnlyParkGrant(receiver: string | null | undefined, bots: Iterable<ParkBot>): boolean {
  const list = [...bots];
  if (receiver) return list.find((b) => b.id === receiver)?.knownBotsOnlyChannel === true;
  const observers = list.filter((b) => b.connected === true);
  return observers.length > 0 && observers.every((b) => b.knownBotsOnlyChannel);
}

export function sumValues(map: Record<string, number> | undefined): number {
  return Object.values(map ?? {}).reduce((n, v) => n + (Number.isFinite(v) ? v : 0), 0);
}

export function receiverDaveReady(snap: BetaSnapshotIn): boolean {
  const id = snap.receiver;
  if (!id) return false;
  const info = snap.dave?.[id];
  return info?.ready === true && (info.protocolVersion ?? 0) >= 1;
}

function senderReady(s: { inChannel?: boolean; healthy?: boolean; daveReady?: boolean } | undefined): boolean {
  return s?.inChannel === true && s?.healthy !== false && s?.daveReady === true;
}

function occupancyBlocked(snap: BetaSnapshotIn): boolean {
  return (snap.occupancy ?? []).some((row) => {
    const occupied = row.occupied === true || row.occupant != null;
    return occupied && row.eligible === false;
  });
}

function connectedSenderIds(snap: BetaSnapshotIn): Set<string> {
  if (snap.connectedSlots) return new Set(snap.connectedSlots);
  return new Set(Object.entries(snap.senders ?? {}).filter(([, s]) => s.inChannel === true).map(([id]) => id));
}

/** Desired/required senders. Empty desiredSlots means none required (idle). Occupied eligible slots otherwise. */
function requiredSenderIds(snap: BetaSnapshotIn): string[] {
  if (snap.desiredSlots) return snap.desiredSlots;
  const fromOccupancy = (snap.occupancy ?? [])
    .filter((row) => row.eligible && (row.occupied === true || row.occupant != null))
    .map((row) => `slot-${row.slot}`);
  if (fromOccupancy.length > 0) return fromOccupancy;
  return [...connectedSenderIds(snap)];
}

function requiredSenderReady(snap: BetaSnapshotIn, id: string, connected: Set<string>): boolean {
  return senderReady({ ...snap.senders?.[id], inChannel: connected.has(id) });
}

export function deriveHealth(snap: BetaSnapshotIn, started: boolean): BetaHealth {
  if (snap.state === "stopping" || snap.state === "stopped") return "fail-closed";
  if (!started || snap.state !== "running") return "starting";
  if (Array.isArray(snap.duplicateReceivers) && snap.duplicateReceivers.length > 0) return "fail-closed";
  if (!receiverDaveReady(snap)) {
    // Occupancy integers alone can lag a human join. Park only on the same grant as audio idle.
    // Initial bots-only MLS wait has no elected receiver yet; do not invent one.
    if (snap.botsOnlyPark === true && (snap.scheduledReconnects ?? 0) === 0) return "parked";
    return "fail-closed";
  }
  if (!snap.receiver) return "fail-closed";
  const refused = snap.refusedSlots?.length ?? 0;
  const unavailable = snap.unavailableRoutes ?? 0;
  const occupied = snap.occupiedSlots ?? 0;
  const connected = connectedSenderIds(snap);
  const required = requiredSenderIds(snap);
  const usable = required.filter((id) => requiredSenderReady(snap, id, connected)).length;
  const requiredGap = required.some((id) => !requiredSenderReady(snap, id, connected));
  const blocked = occupancyBlocked(snap);
  if ((unavailable > 0 && occupied === 0) || ((unavailable > 0 || blocked) && usable === 0 && required.length > 0)) {
    return "unavailable";
  }
  if (
    refused > 0 ||
    unavailable > 0 ||
    blocked ||
    requiredGap ||
    (snap.scheduledReconnects ?? 0) > 0 ||
    sumValues(snap.decryptErrors) > 0
  ) {
    return "degraded";
  }
  return "ok";
}

export function pushEvent(events: BetaEvent[], kind: BetaEventKind, detail?: BetaEvent["detail"]): BetaEvent {
  const ev: BetaEvent = { at: new Date().toISOString(), kind };
  if (detail) ev.detail = detail;
  events.push(ev);
  while (events.length > EVENT_CAP) events.shift();
  return ev;
}

export function diffEvents(prev: BetaSnapshotIn | null, next: BetaSnapshotIn, events: BetaEvent[]): BetaEvent[] {
  const added: BetaEvent[] = [];
  const emit = (kind: BetaEventKind, detail?: BetaEvent["detail"]) => added.push(pushEvent(events, kind, detail));
  if (!prev) return added;
  if (prev.receiver !== next.receiver) emit("receiver_changed", { from: prev.receiver ?? null, to: next.receiver ?? null });
  if (prev.generation !== next.generation) emit("generation_changed", { from: prev.generation ?? null, to: next.generation ?? null });
  const wasReady = receiverDaveReady(prev);
  const isReady = receiverDaveReady(next);
  if (!wasReady && isReady) emit("dave_ready", { receiver: next.receiver ?? null });
  if (wasReady && !isReady) emit("dave_lost", { receiver: next.receiver ?? null });
  if ((prev.scheduledReconnects ?? 0) === 0 && (next.scheduledReconnects ?? 0) > 0) {
    emit("reconnect_scheduled", { count: next.scheduledReconnects ?? 0 });
  }
  if (prev.state === "running" && (next.state === "stopping" || next.state === "stopped")) emit("stopping");
  const prevRefused = new Set(prev.refusedSlots ?? []);
  for (const id of next.refusedSlots ?? []) {
    if (!prevRefused.has(id)) emit("slot_refused", { slot: id });
  }
  if ((prev.unavailableRoutes ?? 0) === 0 && (next.unavailableRoutes ?? 0) > 0) {
    emit("route_unavailable", { count: next.unavailableRoutes ?? 0 });
  }
  return added;
}

export function buildBetaStatus(input: {
  sourceCommit: string;
  snap: BetaSnapshotIn;
  events: BetaEvent[];
  started: boolean;
  singleAttempt: boolean;
}): Record<string, unknown> {
  return {
    mode: PRIVATE_BETA_MODE,
    experimental: true,
    publicDistribution: false,
    sourceCommit: input.sourceCommit,
    at: new Date().toISOString(),
    state: input.snap.state ?? "created",
    health: deriveHealth(input.snap, input.started),
    singleAttempt: input.singleAttempt,
    receiver: input.snap.receiver ?? null,
    generation: input.snap.generation ?? 0,
    daveReady: receiverDaveReady(input.snap),
    scheduledReconnects: input.snap.scheduledReconnects ?? 0,
    duplicateReceivers: Array.isArray(input.snap.duplicateReceivers) ? input.snap.duplicateReceivers.length : 0,
    voiceMembers: input.snap.voiceMembers ?? null,
    voiceBots: input.snap.voiceBots ?? null,
    botsOnlyPark: input.snap.botsOnlyPark === true,
    counters: {
      decryptErrors: sumValues(input.snap.decryptErrors),
      daveReplacements: sumValues(input.snap.daveReplacements),
      recoveries: sumValues(input.snap.recoveries),
      framesSent: input.snap.d2t?.framesSent ?? 0,
      daveDropped: input.snap.d2t?.daveDropped ?? 0,
      admissionDropped: input.snap.d2t?.admissionDropped ?? 0,
      selfSourceDrops: input.snap.d2t?.selfSourceDrops ?? 0,
      t2dReceived: input.snap.t2d?.received ?? 0,
      t2dForwarded: input.snap.t2d?.forwarded ?? 0,
      t2dUnsupportedFrames: input.snap.t2d?.unsupportedFrames ?? 0,
      t2dInvalidFrames: input.snap.t2d?.invalidFrames ?? 0,
      t2dDecodeErrors: input.snap.t2d?.decodeErrors ?? 0,
      t2dVoiceStops: input.snap.t2d?.voiceStops ?? 0,
      t2dMalformed: input.snap.t2d?.malformed ?? 0,
      t2dUnknownSpeakers: input.snap.t2d?.unknownSpeakers ?? 0,
      t2dOwnVoice: input.snap.t2d?.ownVoice ?? 0,
      t2dExcluded: input.snap.t2d?.excluded ?? 0,
      t2dNotInChannel: input.snap.t2d?.notInChannel ?? 0,
      t2dUnavailable: input.snap.t2d?.unavailable ?? 0,
      tsWhisperDropped: input.snap.tsTransport?.whisperDropped ?? 0,
    },
    senders: input.snap.senders ?? {},
    slots: {
      desired: input.snap.desiredSlots ?? [],
      connected: input.snap.connectedSlots ?? [],
      refused: input.snap.refusedSlots ?? [],
      occupied: input.snap.occupiedSlots ?? 0,
      unavailableRoutes: input.snap.unavailableRoutes ?? 0,
    },
    recovery: input.snap.recovery ?? {},
    occupancy: input.snap.occupancy ?? [],
    events: input.events.slice(-EVENT_CAP),
  };
}

export function hostStatusView(status: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: status.mode,
    experimental: status.experimental,
    sourceCommit: status.sourceCommit,
    at: status.at,
    state: status.state,
    health: status.health,
    daveReady: status.daveReady,
  };
}

export function writeAtomicJson(path: string, value: unknown, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // 0755 so the host can reach host-status.json; detailed files stay 0600.
  chmodSync(dir, 0o755);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  chmodSync(path, mode);
}

export function writeBetaStatusFiles(dir: string, status: Record<string, unknown>): void {
  writeAtomicJson(join(dir, "private-beta-status.json"), status, 0o600);
  writeAtomicJson(join(dir, "host-status.json"), hostStatusView(status), 0o644);
}

/** Docker process liveness, not application audio readiness. Degraded/unavailable routing stays up. */
export function healthcheckOk(status: Record<string, unknown>, now = Date.now()): boolean {
  if (status.mode !== PRIVATE_BETA_MODE) return false;
  const at = Date.parse(String(status.at ?? ""));
  if (!Number.isFinite(at) || now - at > 30_000) return false;
  if (status.state !== "running") return false;
  if (status.health === "parked") return true;
  if (!status.receiver) return false;
  if (status.daveReady !== true) return false;
  return status.health === "ok" || status.health === "degraded" || status.health === "unavailable";
}

/** Host `status` must not treat a leftover file as live health after the container stops. */
export function hostHealthLabel(status: Record<string, unknown> | null, containerRunning: boolean): "ok" | "degraded" | "unavailable" | "parked" | "fail-closed" | "starting" | "stale" | "absent" {
  if (!containerRunning) return status ? "stale" : "absent";
  if (!status) return "absent";
  const h = status.health;
  if (h === "ok" || h === "degraded" || h === "unavailable" || h === "parked" || h === "fail-closed" || h === "starting") return h;
  return "fail-closed";
}
