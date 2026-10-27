import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PRIVATE_BETA_MODE = "private-beta" as const;
export const STATUS_FILE = "evidence/private-beta-status.json";
export const EVENT_CAP = 200;

export type BetaHealth = "starting" | "ok" | "degraded" | "fail-closed";
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
  if (!snap.receiver || !receiverDaveReady(snap)) return "fail-closed";
  if (Array.isArray(snap.duplicateReceivers) && snap.duplicateReceivers.length > 0) return "fail-closed";
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
    counters: {
      decryptErrors: sumValues(input.snap.decryptErrors),
      daveReplacements: sumValues(input.snap.daveReplacements),
      recoveries: sumValues(input.snap.recoveries),
      framesSent: input.snap.d2t?.framesSent ?? 0,
      daveDropped: input.snap.d2t?.daveDropped ?? 0,
      admissionDropped: input.snap.d2t?.admissionDropped ?? 0,
      selfSourceDrops: input.snap.d2t?.selfSourceDrops ?? 0,
    },
    events: input.events.slice(-EVENT_CAP),
  };
}

export function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}
