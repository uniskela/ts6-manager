import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PRIVATE_BETA_MODE = "private-beta" as const;
export const STATUS_FILE = "evidence/private-beta-status.json";
export const HOST_STATUS_FILE = "evidence/host-status.json";
export const EVENT_CAP = 200;

export type BetaHealth = "starting" | "ok" | "degraded" | "parked" | "fail-closed";
export type BetaEventKind =
  | "starting"
  | "bridge_running"
  | "dave_ready"
  | "dave_lost"
  | "receiver_changed"
  | "generation_changed"
  | "reconnect_scheduled"
  | "unhealthy"
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
  /** Receiver uses the same bots-only grant as DAVE idle park (voice-state plus MLS peers). */
  botsOnlyPark?: boolean;
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

export function deriveHealth(snap: BetaSnapshotIn, started: boolean): BetaHealth {
  if (snap.state === "stopping" || snap.state === "stopped") return "fail-closed";
  if (!started || snap.state !== "running") return "starting";
  if (Array.isArray(snap.duplicateReceivers) && snap.duplicateReceivers.length > 0) return "fail-closed";
  if (!snap.receiver) return "fail-closed";
  if (!receiverDaveReady(snap)) {
    // Occupancy integers alone can lag a human join. Park only on the same grant as audio idle.
    if (snap.botsOnlyPark === true && (snap.scheduledReconnects ?? 0) === 0) return "parked";
    return "fail-closed";
  }
  if ((snap.scheduledReconnects ?? 0) > 0 || sumValues(snap.decryptErrors) > 0 || sumValues(snap.recoveries) > 0) {
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
      tsWhisperDropped: input.snap.tsTransport?.whisperDropped ?? 0,
    },
    senders: input.snap.senders ?? {},
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

/** Docker HEALTHCHECK: DAVE + receiver, not merely process uptime. Stale files fail. */
export function healthcheckOk(status: Record<string, unknown>, now = Date.now()): boolean {
  if (status.mode !== PRIVATE_BETA_MODE) return false;
  const at = Date.parse(String(status.at ?? ""));
  if (!Number.isFinite(at) || now - at > 30_000) return false;
  if (status.state !== "running") return false;
  if (!status.receiver) return false;
  if (status.health === "parked") return true;
  if (status.daveReady !== true) return false;
  return status.health === "ok" || status.health === "degraded";
}

/** Host `status` must not treat a leftover file as live health after the container stops. */
export function hostHealthLabel(status: Record<string, unknown> | null, containerRunning: boolean): "ok" | "degraded" | "parked" | "fail-closed" | "starting" | "stale" | "absent" {
  if (!containerRunning) return status ? "stale" : "absent";
  if (!status) return "absent";
  const h = status.health;
  if (h === "ok" || h === "degraded" || h === "parked" || h === "fail-closed" || h === "starting") return h;
  return "fail-closed";
}
