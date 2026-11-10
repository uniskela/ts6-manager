/**
 * Test harness: discord.js's own REST stack with only the network edge replaced.
 *
 * `UserManager.fetch`, `REST.get`, `REST.request`, the route handler queue (all `GET /users/:id`
 * requests share one sequential bucket queue per client), the per-attempt timeout with its
 * AbortSignal and the retries all run unchanged. Only `makeRequest`, the function that would put
 * bytes on the wire, is a promise the test settles, and it ignores the AbortSignal unless asked to
 * honour it, so a request can be made to stall indefinitely.
 *
 * Two counts are kept, across every client given the same `RestCounters`:
 * - operations: `REST.request` calls not yet settled, queued or on the wire. This is the
 *   "underlying request" the identity lookup is waiting on.
 * - onWire: `makeRequest` calls not yet settled.
 *
 * This is simulated Discord evidence. It is never live Discord evidence.
 */
import type { Client } from "discord.js";

export interface WireRequest {
  url: string;
  method: string;
  /** The per-attempt AbortSignal discord.js passed in. */
  signal: AbortSignal | undefined;
  settled: boolean;
  /** Answer with a JSON body. */
  respond(body: unknown, status?: number): void;
  fail(error: Error): void;
}

export interface RestCounters {
  operations: number;
  maxOperations: number;
  onWire: number;
  maxOnWire: number;
  /** Every `REST.request` started, by route, in order. */
  started: string[];
}

export const restCounters = (): RestCounters => ({ operations: 0, maxOperations: 0, onWire: 0, maxOnWire: 0, started: [] });

/** What Discord's `GET /users/{id}` returns. */
export const apiUser = (id: string, bot: boolean) => ({ id, username: `user${id.slice(-3)}`, discriminator: "0", global_name: null, avatar: null, bot });

interface RestInternals {
  request(o: { fullRoute: string; method: string }): Promise<unknown>;
  options: { makeRequest: (url: string, init: { method?: string; signal?: AbortSignal }) => Promise<unknown>; timeout: number; retries: number };
}

export function controlQueuedRest(client: Client, counters: RestCounters = restCounters(), o: { honourAbort?: boolean } = {}) {
  client.rest.setToken("test-token"); // REST refuses an authenticated route without one
  const rest = client.rest as unknown as RestInternals;
  const wire: WireRequest[] = [];
  const request = rest.request.bind(rest);
  rest.request = (req) => {
    counters.operations += 1;
    counters.maxOperations = Math.max(counters.maxOperations, counters.operations);
    counters.started.push(`${req.method} ${req.fullRoute}`);
    const p = request(req);
    const done = () => {
      counters.operations -= 1;
    };
    p.then(done, done);
    return p;
  };
  rest.options.makeRequest = (url, init) =>
    new Promise((resolve, reject) => {
      counters.onWire += 1;
      counters.maxOnWire = Math.max(counters.maxOnWire, counters.onWire);
      const settle = (fn: () => void) => {
        if (call.settled) return;
        call.settled = true;
        counters.onWire -= 1;
        fn();
      };
      const call: WireRequest = {
        url,
        method: init.method ?? "GET",
        signal: init.signal,
        settled: false,
        respond: (body, status = 200) => settle(() => resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))),
        fail: (e) => settle(() => reject(e)),
      };
      if (o.honourAbort && init.signal) {
        init.signal.addEventListener("abort", () => {
          const e = new Error("This operation was aborted");
          e.name = "AbortError";
          call.fail(e);
        });
      }
      wire.push(call);
    });
  return {
    wire,
    counters,
    /** Requests on the wire right now, oldest first. */
    open: () => wire.filter((w) => !w.settled),
    /** Fail everything still on the wire, until nothing is left queued behind it either. */
    async drain(): Promise<void> {
      for (let i = 0; i < 64; i++) {
        const open = wire.filter((w) => !w.settled);
        if (open.length === 0 && counters.operations === 0) return;
        for (const w of open) w.fail(new Error("test over"));
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
}
