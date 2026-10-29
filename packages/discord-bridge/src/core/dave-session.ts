/**
 * Which DAVE session is in force on a voice connection.
 *
 * "DAVE is established" is not enough to bind audio to a session: one established session can be
 * replaced by another with no moment in between that a poll would see. In `@discordjs/voice` 0.19.2
 * that happens three ways:
 * - the connection gets a new `Networking` (a voice server change), which brings a new `DAVESession`;
 * - the `DAVESession` wrapper is swapped for another;
 * - the wrapper re-initialises in place (`DAVESession.reinit()`: an invalid transition, a new epoch 1
 *   or a protocol change). The connection, Networking, wrapper and native session objects all stay
 *   the same; only the MLS session underneath is new.
 *
 * `daveSessionIdentity` reads the first two from object identity and counts the third by wrapping
 * the wrapper's own `reinit`, counting before the original runs, so a check made during or after a
 * re-initialisation already sees a different session. Welcome and commit on an already-identified
 * wrapper are the same session: they are how a pending local group becomes established, and how
 * members are added later. Reception starts only after DAVE is ready, so those handshakes are not
 * a replacement. A real MLS reset goes through `reinit()` first.
 *
 * Fail closed: when any part cannot be read, or the wrapper cannot be instrumented, there is no
 * identity (`null`), and callers treat DAVE as not established.
 */
export interface DaveSessionIdentity {
  readonly networking: object;
  readonly wrapper: object;
  readonly native: object;
  /** Re-initialisations of this wrapper since it was first seen. */
  readonly changes: number;
}

interface Counter {
  n: number;
}

const COUNTED = ["reinit"] as const;
const counters = new WeakMap<object, Counter>();

/** Count every re-initialisation of this wrapper from now on. `null` when it cannot be instrumented. */
function instrument(wrapper: object): Counter | null {
  const known = counters.get(wrapper);
  if (known) return known;
  const w = wrapper as Record<string, unknown>;
  if (!Object.isExtensible(wrapper) || COUNTED.some((m) => typeof w[m] !== "function" || Object.getOwnPropertyDescriptor(wrapper, m)?.configurable === false)) return null;
  const counter: Counter = { n: 0 };
  for (const method of COUNTED) {
    const original = w[method] as (...args: unknown[]) => unknown;
    Object.defineProperty(wrapper, method, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function counted(this: unknown, ...args: unknown[]) {
        counter.n += 1; // before the session changes, never after
        return original.apply(this, args);
      },
    });
  }
  counters.set(wrapper, counter);
  return counter;
}

interface MaybeReady {
  status?: string;
  networking?: { state?: { dave?: { session?: unknown } } };
}

/** The DAVE session in force on this connection now, or `null` when it cannot be identified. */
export function daveSessionIdentity(connection: { state?: unknown }): DaveSessionIdentity | null {
  const state = connection.state as MaybeReady | undefined;
  if (state?.status !== "ready") return null;
  const networking = state.networking;
  const wrapper = networking?.state?.dave;
  const native = wrapper?.session;
  if (!networking || typeof networking !== "object" || !wrapper || typeof wrapper !== "object" || !native || typeof native !== "object") return null;
  const counter = instrument(wrapper);
  if (!counter) return null;
  return { networking, wrapper, native, changes: counter.n };
}

function same(a: DaveSessionIdentity, b: DaveSessionIdentity): boolean {
  return a.networking === b.networking && a.wrapper === b.wrapper && a.native === b.native && a.changes === b.changes;
}

/**
 * Numbers the DAVE sessions one bot has seen. The number only moves forward: a session that differs
 * in any way from the last one seen gets the next number, so an epoch, once left, never comes back.
 */
export class DaveSessionEpochs {
  private last: DaveSessionIdentity | null = null;
  private epoch = 0;

  /** The epoch of this identity, or `null` when there is none (fail closed). */
  of(identity: DaveSessionIdentity | null): number | null {
    if (!identity) return null;
    if (!this.last || !same(this.last, identity)) {
      this.epoch += 1;
      this.last = identity;
    }
    return this.epoch;
  }

  /** The connection is gone: drop the references. Whatever is seen next is a new epoch. */
  forget(): void {
    this.last = null;
  }

  /** The highest epoch issued so far (diagnostics). */
  get latest(): number {
    return this.epoch;
  }
}
