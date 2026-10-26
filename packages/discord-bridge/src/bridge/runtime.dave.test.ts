import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Admission } from "../core/voice-admission.js";
import { talk, tick, waitFor } from "../testing/fake-voice.js";
import { realRuntime, validOpus } from "../testing/real-runtime.js";

/**
 * DAVE is checked against the LIVE connection at the last boundary before TeamSpeak, not against the
 * election's cached flag, which the watchdog refreshes only every `watchdogMs`. These tests hold the
 * watchdog off so the window the review found stays open, and never call anything that would make the
 * adapter look at DAVE as a side effect.
 *
 * Frames are injected with the voice admission the receiver really issued: "human" speaks first, so
 * the admission check (which comes before the DAVE check) passes and only DAVE decides.
 */
describe("Discord to TeamSpeak: the final boundary uses the live DAVE state (real runtime, real connection)", () => {
  async function started() {
    const r = realRuntime({ users: 1, timing: { watchdogMs: 5000 } });
    await r.rt.start();
    await r.rt.idle();
    const receiver = r.election.receiver!;
    const t = r.tests.get(receiver)!;
    const h = t.latest();
    // "human" speaks through the real receive path until the runtime has a frame with its admission.
    let admission: Admission | undefined;
    const forward = r.rt.onHumanOpus;
    (r.rt as unknown as { onHumanOpus: typeof forward }).onHumanOpus = (b, g, u, o, a) => {
      admission ??= a;
      forward(b, g, u, o, a);
    };
    const packet = validOpus();
    h.mapUser("human", 4321);
    const stop = talk(h, "human", () => packet);
    await waitFor(() => admission, 1500, "an admitted frame from the human");
    stop();
    await tick(150); // everything they said is mixed out
    return { r, receiver, t, h, admission: admission! };
  }

  it("a frame queued while DAVE was established is dropped, not forwarded, when DAVE is lost before the watchdog notices", async () => {
    const { r, receiver, h, admission } = await started();
    try {
      r.ts.out.length = 0;
      r.rt.onHumanOpus(receiver, r.election.generation, "human", validOpus(), admission);
      assert.equal(r.ts.out.length, 0, "queued, not yet mixed");
      h.setDave({ protocolVersion: 0 }); // lost now; the watchdog will not look for 5 s
      r.rt.d2t.tick(20); // the very next mix tick
      assert.equal(r.ts.out.length, 0, "the queued frame was not forwarded");
      assert.equal(r.rt.status().d2t.daveDropped, 1, "and it is counted as a DAVE drop");
      h.setDave({ protocolVersion: 1 }); // established again: the dropped frame must not come back
      r.rt.d2t.tick(40);
      r.rt.d2t.tick(60);
      assert.equal(r.ts.out.length, 0, "dropped for good, not merely delayed");
    } finally {
      await r.cleanup();
    }
  });

  it("a frame arriving while DAVE is lost is never queued", async () => {
    const { r, receiver, h, admission } = await started();
    try {
      r.ts.out.length = 0;
      h.setDave({ protocolVersion: 0 });
      r.rt.onHumanOpus(receiver, r.election.generation, "human", validOpus(), admission);
      r.rt.d2t.tick(20);
      assert.equal(r.ts.out.length, 0);
      assert.equal(r.rt.status().d2t.daveDropped, 1);
    } finally {
      await r.cleanup();
    }
  });

  it("audio flows again once DAVE is established, and the loss reaches the election through the normal path", async () => {
    const { r, receiver, t, h, admission } = await started();
    try {
      h.setDave({ protocolVersion: 0 });
      r.rt.onHumanOpus(receiver, r.election.generation, "human", validOpus(), admission);
      r.rt.d2t.tick(20); // the live check noticed first; the adapter observes it on a microtask
      await waitFor(() => !t.bot.daveInfo || t.bot.daveInfo.protocolVersion === 0, 200, "loss visible");
      await tick(10);
      h.setDave({ protocolVersion: 1 });
      await waitFor(() => r.election.admitFrame(receiver, r.election.generation), 1000, "the receiver is admitted again");
      // The loss stopped reception, and every admission of that receive session ended with it.
      assert.equal(t.bot.humanAdmitted("human", admission), false, "the admission from before the loss is not honoured again");
      r.ts.out.length = 0;
      const packet = validOpus();
      const live = t.latest(); // the connection the bot holds now (it may have been rebuilt during the outage)
      live.mapUser("human", 4321);
      const stop = talk(live, "human", () => packet); // heard again through the real path, under a new admission
      try {
        await waitFor(() => r.ts.out.length > 0, 1500, "audio reaches TeamSpeak again");
      } finally {
        stop();
      }
    } finally {
      await r.cleanup();
    }
  });
});
