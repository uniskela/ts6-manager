/**
 * Privacy-safe DAVE negotiation trace for `@discordjs/voice` 0.19.2.
 *
 * Records MLS *categories* (key package sent, external sender, welcome/commit, transitions) and
 * readiness. Never reads or logs tokens, voice credentials, key material, privacy codes, raw MLS
 * payloads or audio. Fail-closed gates are unchanged: this only observes.
 */
export type DaveEventKind =
  | "reinit"
  | "external_sender"
  | "proposals"
  | "commit"
  | "welcome"
  | "prepare_epoch"
  | "prepare_transition"
  | "execute_transition"
  | "key_package"
  | "invalidate"
  | "error";

export interface DaveSnapshot {
  protocolVersion: number | null;
  ready: boolean;
  status: number | null;
  lastTransitionId: number | null;
  pending: number;
  reinitializing: boolean;
  events: Partial<Record<DaveEventKind, number>>;
  /** Outbound voice-gateway DAVE opcodes only (26/28/31). Counts, never payloads. */
  wsOut: Partial<Record<26 | 28 | 31, number>>;
  lastKind: DaveEventKind | null;
  lastOk: boolean | null;
  lastTransition: number | null;
}

type Wrapper = {
  protocolVersion?: number;
  lastTransitionId?: number;
  reinitializing?: boolean;
  pendingTransitions?: { size?: number };
  session?: { ready?: boolean; status?: number };
  on?(event: string, fn: (...args: unknown[]) => void): void;
};

const METHODS: ReadonlyArray<readonly [string, DaveEventKind]> = [
  ["reinit", "reinit"],
  ["setExternalSender", "external_sender"],
  ["processProposals", "proposals"],
  ["processCommit", "commit"],
  ["processWelcome", "welcome"],
  ["prepareEpoch", "prepare_epoch"],
  ["prepareTransition", "prepare_transition"],
  ["executeTransition", "execute_transition"],
];

const traces = new WeakMap<object, DaveSnapshot>();
const wrappedWs = new WeakSet<object>();

export function emptyDaveSnapshot(): DaveSnapshot {
  return {
    protocolVersion: null,
    ready: false,
    status: null,
    lastTransitionId: null,
    pending: 0,
    reinitializing: false,
    events: {},
    wsOut: {},
    lastKind: null,
    lastOk: null,
    lastTransition: null,
  };
}

function readTransition(kind: DaveEventKind, args: unknown[]): number | null {
  const a0 = args[0];
  if (kind === "commit" || kind === "welcome") {
    if (Buffer.isBuffer(a0) && a0.length >= 2) return a0.readUInt16BE(0);
    return null;
  }
  if (kind === "execute_transition" && typeof a0 === "number") return a0;
  if (kind === "invalidate" && typeof a0 === "number") return a0;
  if (a0 && typeof a0 === "object") {
    const o = a0 as { transition_id?: number; epoch?: number };
    if (kind === "prepare_transition" && typeof o.transition_id === "number") return o.transition_id;
    if (kind === "prepare_epoch" && typeof o.epoch === "number") return o.epoch;
  }
  return null;
}

function refresh(wrapper: object, snap: DaveSnapshot): void {
  const w = wrapper as Wrapper;
  snap.protocolVersion = typeof w.protocolVersion === "number" ? w.protocolVersion : null;
  snap.ready = w.session?.ready === true;
  snap.status = typeof w.session?.status === "number" ? w.session.status : null;
  snap.lastTransitionId = typeof w.lastTransitionId === "number" ? w.lastTransitionId : null;
  snap.pending = typeof w.pendingTransitions?.size === "number" ? w.pendingTransitions.size : 0;
  snap.reinitializing = w.reinitializing === true;
}

function note(snap: DaveSnapshot, wrapper: object, kind: DaveEventKind, ok: boolean, transition: number | null): void {
  snap.events[kind] = (snap.events[kind] ?? 0) + 1;
  snap.lastKind = kind;
  snap.lastOk = ok;
  snap.lastTransition = transition;
  refresh(wrapper, snap);
}

/** Observe this wrapper once. Later calls return the same snapshot. `null` if it cannot be instrumented. */
export function observeDave(wrapper: object): DaveSnapshot | null {
  const known = traces.get(wrapper);
  if (known) {
    refresh(wrapper, known);
    return known;
  }
  if (!Object.isExtensible(wrapper)) return null;
  const w = wrapper as Record<string, unknown>;
  for (const [method] of METHODS) {
    if (typeof w[method] !== "function") continue;
    if (Object.getOwnPropertyDescriptor(wrapper, method)?.configurable === false) return null;
  }
  const snap: DaveSnapshot = emptyDaveSnapshot();
  for (const [method, kind] of METHODS) {
    if (typeof w[method] !== "function") continue;
    const original = w[method] as (...args: unknown[]) => unknown;
    Object.defineProperty(wrapper, method, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function observed(this: unknown, ...args: unknown[]) {
        const transition = readTransition(kind, args);
        try {
          const result = original.apply(this, args);
          const ok = !(result && typeof result === "object" && "success" in result && (result as { success: unknown }).success === false);
          const tid =
            result && typeof result === "object" && typeof (result as { transitionId?: unknown }).transitionId === "number"
              ? (result as { transitionId: number }).transitionId
              : transition;
          note(snap, wrapper, kind, ok, tid);
          return result;
        } catch (e) {
          note(snap, wrapper, kind, false, transition);
          throw e;
        }
      },
    });
  }
  const emitter = wrapper as Wrapper;
  emitter.on?.("keyPackage", () => note(snap, wrapper, "key_package", true, null));
  emitter.on?.("invalidateTransition", (id: unknown) => note(snap, wrapper, "invalidate", true, typeof id === "number" ? id : null));
  emitter.on?.("error", () => note(snap, wrapper, "error", false, null));
  traces.set(wrapper, snap);
  refresh(wrapper, snap);
  return snap;
}

/** Count an outbound DAVE opcode. Ignores anything except 26/28/31. Never stores the payload. */
export function noteDaveWsOut(snap: DaveSnapshot, opcode: number): void {
  if (opcode !== 26 && opcode !== 28 && opcode !== 31) return;
  snap.wsOut[opcode] = (snap.wsOut[opcode] ?? 0) + 1;
}

/** Observe sendBinaryMessage: opcode integer only. */
export function observeDaveWs(ws: object, snap: DaveSnapshot | (() => DaveSnapshot)): void {
  const rec = ws as { sendBinaryMessage?: (opcode: number, payload: unknown) => unknown };
  if (typeof rec.sendBinaryMessage !== "function" || wrappedWs.has(ws)) return;
  if (Object.getOwnPropertyDescriptor(ws, "sendBinaryMessage")?.configurable === false) return;
  wrappedWs.add(ws);
  const get = typeof snap === "function" ? snap : () => snap;
  const original = rec.sendBinaryMessage.bind(ws);
  rec.sendBinaryMessage = (opcode: number, payload: unknown) => {
    noteDaveWsOut(get(), opcode);
    return original(opcode, payload);
  };
}

/** One-line snapshot. Categories and integers only. */
export function formatDaveSnapshot(snap: DaveSnapshot): string {
  const events = Object.entries(snap.events)
    .filter(([, n]) => n)
    .map(([k, n]) => `${k}:${n}`)
    .join(",") || "none";
  const wsOut = Object.entries(snap.wsOut)
    .filter(([, n]) => n)
    .map(([k, n]) => `${k}:${n}`)
    .join(",") || "none";
  const last = snap.lastKind ? `${snap.lastKind}:${snap.lastOk ? "ok" : "fail"}${snap.lastTransition !== null ? `#${snap.lastTransition}` : ""}` : "none";
  return `status=${snap.status ?? "n/a"} nativeReady=${snap.ready} lastTransition=${snap.lastTransitionId ?? "n/a"} pending=${snap.pending} reinit=${snap.reinitializing} last=${last} events=${events} wsOut=${wsOut}`;
}
