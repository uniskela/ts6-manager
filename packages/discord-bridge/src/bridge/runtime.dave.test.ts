import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tick, waitFor } from "../testing/fake-voice.js";
import { realRuntime, validOpus } from "../testing/real-runtime.js";

/**
 * DAVE is checked against the LIVE connection at the last boundary before TeamSpeak, not against the
 * election's cached flag, which the watchdog refreshes only every `watchdogMs`. These tests hold the
 * watchdog off so the window the review found stays open, and never call anything that would make the
 * adapter look at DAVE as a side effect.
 */
describe("Discord to TeamSpeak: the final boundary uses the live DAVE state (real runtime, real connection)", () => {
  async function started() {
    const r = realRuntime({ users: 1, timing: { watchdogMs: 5000 } });
    await r.rt.start();
    await r.rt.idle();
    const receiver = r.election.receiver!;
    const t = r.tests.get(receiver)!;
    return { r, receiver, t, h: t.latest() };
  }

  it("a frame queued while DAVE was established is dropped, not forwarded, when DAVE is lost before the watchdog notices", async () => {
    const { r, receiver, h } = await started();
    r.ts.out.length = 0;
    r.rt.onHumanOpus(receiver, r.election.generation, "human", validOpus());
    assert.equal(r.ts.out.length, 0, "queued, not yet mixed");
    h.setDave({ protocolVersion: 0 }); // lost now; the watchdog will not look for 5 s
    r.rt.d2t.tick(20); // the very next mix tick
    assert.equal(r.ts.out.length, 0, "the queued frame was not forwarded");
    assert.equal(r.rt.status().d2t.daveDropped, 1, "and it is counted as a DAVE drop");
    h.setDave({ protocolVersion: 1 }); // established again: the dropped frame must not come back
    r.rt.d2t.tick(40);
    r.rt.d2t.tick(60);
    assert.equal(r.ts.out.length, 0, "dropped for good, not merely delayed");
    await r.cleanup();
  });

  it("a frame arriving while DAVE is lost is never queued", async () => {
    const { r, receiver, h } = await started();
    r.ts.out.length = 0;
    h.setDave({ protocolVersion: 0 });
    r.rt.onHumanOpus(receiver, r.election.generation, "human", validOpus());
    r.rt.d2t.tick(20);
    assert.equal(r.ts.out.length, 0);
    assert.equal(r.rt.status().d2t.daveDropped, 1);
    await r.cleanup();
  });

  it("audio flows again once DAVE is established, and the loss reaches the election through the normal path", async () => {
    const { r, receiver, t, h } = await started();
    h.setDave({ protocolVersion: 0 });
    r.rt.onHumanOpus(receiver, r.election.generation, "human", validOpus());
    r.rt.d2t.tick(20); // the live check noticed first; the adapter observes it on a microtask
    await waitFor(() => !t.bot.daveInfo || t.bot.daveInfo.protocolVersion === 0, 200, "loss visible");
    await tick(10);
    h.setDave({ protocolVersion: 1 });
    await waitFor(() => r.election.admitFrame(receiver, r.election.generation), 1000, "the receiver is admitted again");
    r.ts.out.length = 0;
    r.rt.onHumanOpus(receiver, r.election.generation, "human", validOpus());
    await waitFor(() => r.ts.out.length > 0, 1000, "audio reaches TeamSpeak again");
    await r.cleanup();
  });
});
