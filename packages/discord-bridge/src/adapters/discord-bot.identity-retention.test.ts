/**
 * Finding 2 of the review of 08041a9: an identity request that never settles must not keep every
 * bot and identity filter that ever waited on it.
 *
 * The production lookup runs (the real `UserManager.fetch`, `REST.get`, `REST.request` and route
 * queue). The one request on the wire never settles, and the test keeps it reachable the way an
 * open socket would: what that request itself holds is discord.js's and the network's business,
 * and is reported separately below, not hidden.
 *
 * Reachability is measured with `WeakRef` after forced full collections (`testing/gc.ts`), alongside
 * structural counts that do not depend on the collector: the registry's subscriber count and the
 * number of underlying REST operations.
 *
 * Simulated Discord evidence, never live.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IdentityRequests } from "../core/identity-requests.js";
import { preferredOrder } from "../core/ids.js";
import { ReceiverElection } from "../core/receiver-election.js";
import type { Admission } from "../core/voice-admission.js";
import { apiUser, controlQueuedRest, restCounters, type WireRequest } from "../testing/controlled-rest.js";
import { talk, testBot, tick, waitFor } from "../testing/fake-voice.js";
import { alive } from "../testing/gc.js";

const USER = "200000000000009901";
const REPLACEMENTS = 30;

function newElection() {
  const election = new ReceiverElection(preferredOrder(5));
  election.setState("slot-0", { healthy: true, inChannel: true });
  election.reconcile("start");
  return election;
}

/** One bot instance asks about USER and is destroyed. Returns weak references only, plus the wire if it opened one. */
async function oneInstance(registry: IdentityRequests, counters: ReturnType<typeof restCounters>) {
  const election = newElection();
  const t = testBot("slot-0", election, { productionLookup: true, identityRequests: registry });
  const rest = controlQueuedRest(t.bot.client, counters);
  const h = await t.join({ receive: true });
  assert.equal(t.bot.startReceive(election.generation), true);
  h.mapUser(USER, 9100);
  const stop = talk(h, USER);
  await waitFor(() => t.bot.identityLookups.waiting === 1, 1000, "the filter waits on the request");
  stop();
  const refs = { bot: new WeakRef(t.bot), filter: new WeakRef((t.bot as unknown as { humans: object }).humans), client: new WeakRef(t.bot.client) };
  await t.bot.destroy();
  return { refs, wire: rest.wire };
}

describe("a never-settling identity request does not retain the bots and filters that waited on it (finding 2)", () => {
  it(`${REPLACEMENTS} sequential bot/filter replacements, one stalled request: one REST operation, and the old instances are reclaimable`, async (c) => {
    const registry = new IdentityRequests();
    const counters = restCounters();
    const bots: WeakRef<object>[] = [];
    const filters: WeakRef<object>[] = [];
    const clients: WeakRef<object>[] = [];
    /** The wire requests, held as an open socket would hold them. */
    const held: WireRequest[] = [];
    try {
      for (let i = 0; i < REPLACEMENTS; i++) {
        const { refs, wire } = await oneInstance(registry, counters);
        bots.push(refs.bot);
        filters.push(refs.filter);
        clients.push(refs.client);
        held.push(...wire);
      }
      await tick(20);
      assert.equal(counters.started.length, 1, `one underlying REST operation across ${REPLACEMENTS} instances (saw ${counters.started.length})`);
      assert.equal(counters.operations, 1, "and it is still unsettled");
      assert.equal(registry.stats().pending, 1, "the registry still counts it");
      const subscribers = (registry.stats() as { subscribers?: number }).subscribers;
      const [botsAlive, filtersAlive, clientsAlive] = [await alive(bots), await alive(filters), await alive(clients)];
      c.diagnostic(`finding 2: replacements=${REPLACEMENTS} restOperations=${counters.started.length} unsettled=${counters.operations} registrySubscribers=${subscribers ?? "n/a"} retainedBots=${botsAlive} retainedFilters=${filtersAlive} retainedClients=${clientsAlive}`);
      assert.equal(subscribers, 0, "no destroyed filter is still subscribed to the request");
      assert.equal(filtersAlive, 0, `no destroyed filter is retained (saw ${filtersAlive})`);
      assert.equal(botsAlive, 0, `no destroyed bot is retained (saw ${botsAlive})`);
      assert.ok(clientsAlive <= 1, `at most the one discord.js client whose REST request is still on the wire (saw ${clientsAlive})`);
      if (clientsAlive === 1) assert.ok(clients[0].deref(), "and that is the client that started the request (its REST manager owns it)");

      for (const w of held) w.fail(new Error("settled at last"));
      held.length = 0;
      await waitFor(() => counters.operations === 0 && registry.stats().pending === 0, 2000, "the request to settle");
      const clientsAfter = await alive(clients);
      c.diagnostic(`finding 2 after settlement: retainedClients=${clientsAfter} retainedBots=${await alive(bots)}`);
      assert.equal(clientsAfter, 0, "once the request settles, its client is released too");
    } finally {
      for (const w of held) w.fail(new Error("test over"));
      await waitFor(() => counters.operations === 0, 2000, "the request to settle");
    }
  });

  it("late settlement after a replacement: the destroyed bot is not called, a revoked admission stays revoked, and the current bot hears the human only after a rejoin", async () => {
    const registry = new IdentityRequests();
    const counters = restCounters();
    const user = "200000000000009902";
    const election = newElection();
    const got: { bot: string; admission: Admission }[] = [];
    const first = testBot("slot-0", election, { productionLookup: true, identityRequests: registry, onHumanOpus: (_b, _g, _u, _o, a) => got.push({ bot: "first", admission: a }) });
    const firstRest = controlQueuedRest(first.bot.client, counters);
    const h1 = await first.join({ receive: true });
    assert.equal(first.bot.startReceive(election.generation), true);
    h1.mapUser(user, 9200);
    const stop1 = talk(h1, user);
    await waitFor(() => firstRest.open().length === 1, 1000, "the identity request on the wire");
    // Identity arrives another way (gateway member data) while the request is out: admitted, then the user leaves.
    first.voice(user, "channel-1", { member: { bot: false } });
    await waitFor(() => got.length > 0, 1500, "admitted on the first bot");
    const revoked = got[0].admission;
    first.voice(user, null);
    stop1();
    assert.equal(first.bot.humanAdmitted(user, revoked), false, "the departure revoked the admission");
    const firstFilter = (first.bot as unknown as { humans: { size: number } }).humans;
    await first.bot.destroy();

    const second = testBot("slot-0", election, { productionLookup: true, identityRequests: registry, onHumanOpus: (_b, _g, _u, _o, a) => got.push({ bot: "second", admission: a }) });
    const secondRest = controlQueuedRest(second.bot.client, counters);
    const h2 = await second.join({ receive: true });
    assert.equal(second.bot.startReceive(election.generation), true);
    h2.mapUser(user, 9201); // present on the second bot, unknown to its fresh client
    const stop2 = talk(h2, user);
    try {
      await waitFor(() => second.bot.identityLookups.waiting === 1, 1000, "the second bot waits on the request");
      assert.equal(counters.started.length, 1, "it joined the request still out instead of starting one");
      assert.equal(registry.stats().subscribers, 1, "only the current bot's filter is subscribed");
      second.voice(user, null); // gone again before the answer
      firstRest.open()[0].respond(apiUser(user, false));
      await waitFor(() => registry.stats().pending === 0, 1000, "the late settlement");
      await tick(150);
      assert.equal(firstFilter.size, 0, "the destroyed bot's filter was not called");
      assert.ok(!got.some((g) => g.bot === "second"), "absent: the late answer admits nobody");
      assert.equal(second.bot.humanAdmitted(user, revoked), false, "and does not bring back the revoked admission");
      assert.equal(second.bot.admittedHumans, 0);
      second.voice(user, "channel-1");
      await waitFor(() => got.some((g) => g.bot === "second"), 1500, "heard after a real rejoin");
      const fresh = got.filter((g) => g.bot === "second").map((g) => g.admission);
      assert.equal(new Set(fresh).size, 1, "under one fresh admission");
      assert.notEqual(fresh[0], revoked);
      assert.equal(counters.started.length, 1, "with no second request");
    } finally {
      stop2();
      await firstRest.drain();
      await secondRest.drain();
      await second.bot.destroy();
    }
  });
});
