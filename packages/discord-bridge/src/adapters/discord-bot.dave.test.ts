import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AudioPlayerStatus } from "@discordjs/voice";
import type { BotId } from "../core/ids.js";
import { preferredOrder } from "../core/ids.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { DAVE_MAGIC, isSilence, talk, testBot, tick, waitFor, type ReadyHandle } from "../testing/fake-voice.js";

const opus = (n: number) => Buffer.from([0xfc, n, n, n]);
const isDave = (p: Buffer) => p.subarray(0, 4).equals(DAVE_MAGIC);
const plaintextMedia = (wire: Buffer[]) => wire.filter((p) => !isSilence(p) && !isDave(p));

function electedReceiver() {
  const election = new ReceiverElection(preferredOrder(5));
  election.setState("slot-0", { healthy: true, inChannel: true });
  election.reconcile("test");
  return election;
}

describe("DAVE enforcement on the outbound (playback) boundary", () => {
  for (const [name, lost] of [
    ["protocol 0 (downgrade transition)", { protocolVersion: 0 }],
    ["MLS group not ready (epoch transition)", { ready: false }],
  ] as const) {
    it(`${name} while audio is queued and playing: no plaintext media leaves and the buffer is flushed`, async () => {
      const election = electedReceiver();
      const t = testBot("slot-0", election);
      const h = await t.join();
      for (let i = 1; i <= 4; i++) t.bot.sendOpus(opus(i)); // a burst: the player has not drained it yet
      await waitFor(() => h.networking.wire.some((p) => !isSilence(p)), 1000, "playback started");
      h.setDave(lost);
      for (let i = 10; i < 14; i++) t.bot.sendOpus(opus(i)); // the TeamSpeak speaker keeps talking
      await tick(250);
      assert.deepEqual(plaintextMedia(h.networking.wire), [], "no unencrypted media on the wire");
      assert.equal(t.bot.playerStatus, AudioPlayerStatus.Idle, "playback stopped and the buffered audio was discarded");
      await t.bot.destroy();
    });
  }

  it("resumes encrypted playback once DAVE is established again", async () => {
    const election = electedReceiver();
    const t = testBot("slot-0", election);
    const h = await t.join();
    h.setDave({ ready: false });
    t.bot.sendOpus(opus(1));
    await tick(30);
    h.setDave({ ready: true });
    await waitFor(() => {
      t.bot.sendOpus(opus(2));
      return h.networking.wire.some((p) => isDave(p) && p.includes(2));
    }, 1500, "encrypted frames after DAVE returned");
    assert.deepEqual(plaintextMedia(h.networking.wire), []);
    await t.bot.destroy();
  });
});

describe("DAVE enforcement on the receive boundary (real VoiceReceiver)", () => {
  async function receiving() {
    const election = electedReceiver();
    const got: Buffer[] = [];
    const t = testBot("slot-0", election, { onHumanOpus: (_b: BotId, _g: number, _u: string, o: Buffer) => got.push(o) });
    const h = await t.join({ receive: true });
    h.mapUser("human", 1111);
    assert.equal(t.bot.startReceive(election.generation), true);
    return { election, t, h, got };
  }

  const admitted = (h: ReadyHandle) => talk(h, "human", () => opus(7));

  it("delivers a DAVE-decrypted human frame while DAVE is established (control)", async () => {
    const { t, h, got } = await receiving();
    const stop = admitted(h); // identity is resolved in the background, so the speaker keeps talking until admitted
    await waitFor(() => got.length > 0, 1000, "first frame");
    stop();
    assert.deepEqual(got[0], opus(7));
    await t.bot.destroy();
  });

  it("protocol 0: a plaintext packet is dropped, never decoded or queued, and reception is invalidated", async () => {
    const { t, h, got } = await receiving();
    const stop = admitted(h);
    await waitFor(() => got.length > 0, 1000, "first frame");
    stop();
    h.setDave({ protocolVersion: 0 });
    h.udp("human", opus(9), { dave: false });
    h.udp("human", opus(9), { dave: false });
    await tick(60);
    assert.equal(got.filter((o) => o.equals(opus(9))).length, 0, "plaintext frame never reached the pipeline");
    assert.equal(t.bot.openSubscriptions, 0, "stale subscriptions were invalidated");
    await t.bot.destroy();
  });

  it("an established session in davey passthrough mode does not accept plaintext", async () => {
    const { t, h, got } = await receiving();
    const stop = admitted(h); // identify the speaker first, or the plaintext below would be dropped for the wrong reason
    await waitFor(() => got.length > 0, 1000, "an encrypted frame");
    stop();
    await tick(200); // the speaker stops, so the plaintext packet below starts a fresh speaking period
    h.davey.passthrough = true; // the transition window in which davey would let plaintext through
    h.udp("human", opus(8), { dave: false });
    await tick(60);
    assert.equal(got.filter((o) => o.equals(opus(8))).length, 0, "plaintext rejected even while passthrough was enabled");
    await t.bot.destroy();
  });
});

describe("DAVE loss lifecycle on the bot", () => {
  it("holds the receiver through a short transition and reactivates it under a new generation", async () => {
    const election = electedReceiver();
    const t = testBot("slot-0", election);
    const h = await t.join({ receive: true });
    const gen = election.generation;
    const events: string[] = [];
    election.on("teardown", () => events.push("teardown"));
    election.on("elected", () => events.push("elected"));
    h.setDave({ ready: false });
    await waitFor(() => events.includes("teardown"), 1000, "teardown on DAVE loss");
    h.setDave({ ready: true });
    await waitFor(() => events.includes("elected"), 1000, "reactivation when DAVE returned");
    assert.equal(election.receiver, "slot-0");
    assert.ok(election.generation > gen);
    await t.bot.destroy();
  });

  it("declares the bot unhealthy only after the grace window, so the runtime can fail over", async () => {
    const election = electedReceiver();
    const t = testBot("slot-0", election);
    const h = await t.join({ receive: true });
    const reasons: string[] = [];
    t.bot.on("unhealthy", (r: string) => reasons.push(r));
    h.setDave({ ready: false });
    await tick(60);
    assert.deepEqual(reasons, [], "not unhealthy inside the grace window");
    await waitFor(() => reasons.length > 0, 1500, "unhealthy after the grace window");
    assert.match(reasons[0], /DAVE/);
    await t.bot.destroy();
  });
});

describe("DAVE loss in the election and the TeamSpeak mix", () => {
  it("losing DAVE on the receiver tears reception down under a new generation and fences queued frames", () => {
    const election = electedReceiver();
    const gen = election.generation;
    const events: string[] = [];
    election.on("teardown", (e) => events.push(`teardown:${e.bot}`));
    election.on("elected", (e) => events.push(`elected:${e.bot}`));
    election.daveLost("slot-0", "mls transition");
    assert.ok(election.generation > gen, "reception from before the loss is stale");
    assert.equal(election.admitFrame("slot-0", gen), false);
    assert.equal(election.admitFrame("slot-0", election.generation), false, "no frame is admitted while DAVE is unavailable");
    assert.equal(election.admitSubscribe("slot-0", election.generation), false);
    assert.equal(election.receiver, "slot-0", "the holder is kept during the grace window");
    election.daveRestored("slot-0");
    assert.deepEqual(events, ["teardown:slot-0", "elected:slot-0"], "reception is re-activated under a fresh generation");
    assert.equal(election.admitFrame("slot-0", election.generation), true);
    assert.equal(election.admitFrame("slot-0", gen), false);
  });

  it("a non-receiver losing DAVE does not move the receiver or bump the generation", () => {
    const election = electedReceiver();
    election.setState("slot-1", { healthy: true, inChannel: true });
    const gen = election.generation;
    election.daveLost("slot-1", "transition");
    assert.equal(election.receiver, "slot-0");
    assert.equal(election.generation, gen);
  });

  it("a bot without DAVE is not elected as a successor", () => {
    const election = electedReceiver();
    election.setState("slot-1", { healthy: true, inChannel: true });
    election.setState("slot-2", { healthy: true, inChannel: true });
    election.daveLost("slot-1", "transition");
    assert.equal(election.fail("slot-0", "dead"), "slot-2");
  });
});

describe("the packet is checked again at the moment it leaves, not only when it is prepared", () => {
  it("a packet prepared before DAVE was lost is not dispatched, with no further sendOpus to notice the loss", async () => {
    const election = new ReceiverElection(preferredOrder(5));
    const t = testBot("slot-0", election, { timing: { watchdogMs: 5000 } }); // the watchdog cannot be what saves us
    const h = await t.join();
    const prepare = h.networking.prepareAudioPacket.bind(h.networking);
    let lost = false;
    h.networking.prepareAudioPacket = (opus: Buffer) => {
      const packet = prepare(opus);
      if (!lost) {
        lost = true;
        h.setDave({ protocolVersion: 0 }); // lost between the player's prepare and its next dispatch
      }
      return packet;
    };
    t.bot.sendOpus(Buffer.from([0xfc, 42, 42, 42]));
    await waitFor(() => lost, 1000, "the first packet was prepared");
    await tick(120); // several player ticks
    assert.equal(h.dave.protocolVersion, 0);
    assert.equal(h.networking.wire.length, 0, "nothing at all was dispatched after DAVE was lost");
    await t.bot.destroy();
  });

  it("a packet encrypted under one DAVE session is not sent under a different one", async () => {
    const election = new ReceiverElection(preferredOrder(5));
    const t = testBot("slot-0", election, { timing: { watchdogMs: 5000 } });
    const h = await t.join();
    const prepare = h.networking.prepareAudioPacket.bind(h.networking);
    let swapped = false;
    h.networking.prepareAudioPacket = (opus: Buffer) => {
      const packet = prepare(opus);
      if (!swapped) {
        swapped = true;
        h.replaceDave(); // an MLS reset: established again, but a different session
      }
      return packet;
    };
    t.bot.sendOpus(Buffer.from([0xfc, 43, 43, 43]));
    await waitFor(() => swapped, 1000, "the first packet was prepared");
    await tick(120);
    assert.equal(h.networking.wire.filter((p) => !isSilence(p)).length, 0, "the stale packet never left");
    await t.bot.destroy();
  });
});
