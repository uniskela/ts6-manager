import assert from "node:assert/strict";
import { it } from "node:test";
import { AudioPlayerStatus, VoiceConnectionStatus, type VoiceConnection } from "@discordjs/voice";
import { preferredOrder } from "../core/ids.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { testBot, tick, waitFor, talk } from "../testing/fake-voice.js";
import { realRuntime, validOpus } from "../testing/real-runtime.js";

const frame = Buffer.from([0xfc, 41, 42]);
const dispatched = (wire: Buffer[]) => wire.some((p) => p.subarray(4).equals(frame));
function subscription(conn: VoiceConnection) {
  assert.equal(conn.state.status, VoiceConnectionStatus.Ready);
  if (conn.state.status !== VoiceConnectionStatus.Ready) throw new Error("expected ready connection");
  assert.ok(conn.state.subscription);
  return conn.state.subscription;
}

it("sustains 10000 simulated player ticks and resumes after a silent turn", async () => {
  const t = testBot("slot-0", new ReceiverElection(preferredOrder(5)));
  try {
    const h = await t.join();
    t.bot.sendOpus(frame);
    await waitFor(() => dispatched(h.networking.wire), 1000, "initial dispatch");
    const sub = subscription(h.conn);
    const player = sub.player as unknown as { _stepPrepare(): void; _stepDispatch(): void };
    h.networking.wire.length = 0;
    // Accelerated AudioPlayer ticks, not a claim of a wall-clock soak or native MLS validation.
    for (let i = 0; i < 10000; i++) {
      t.bot.sendOpus(frame);
      player._stepPrepare();
      player._stepDispatch();
    }
    assert.ok(h.networking.wire.length >= 9999);
    assert.equal(subscription(h.conn), sub);
    await tick(400); // the 120 ms turn gap and the library's silence tail have expired
    assert.equal(t.bot.playerStatus, AudioPlayerStatus.Idle);
    h.networking.wire.length = 0;
    t.bot.sendOpus(frame);
    await waitFor(() => dispatched(h.networking.wire), 1000, "dispatch after silence");
  } finally { await t.bot.destroy(); }
});

it("subscribes playback after repeated leave/join, connection recreation and receiver rejoin", async () => {
  const t = testBot("slot-0", new ReceiverElection(preferredOrder(5)));
  try {
    for (let cycle = 0; cycle < 4; cycle++) {
      let h = await t.join();
      t.bot.sendOpus(frame);
      await waitFor(() => dispatched(h.networking.wire), 1000, "dispatch after join");
      const sub = subscription(h.conn);
      await t.bot.join({ receive: true });
      assert.equal(t.bot.voiceConnection, h.conn);
      assert.equal(subscription(h.conn), sub, "rejoin retains playback subscription");
      h.networking.wire.length = 0;
      t.bot.sendOpus(frame);
      await waitFor(() => dispatched(h.networking.wire), 1000, "dispatch after undeafening");
      if (cycle === 0) {
        const old = h.conn;
        old.destroy(false);
        h = await t.join();
        assert.notEqual(h.conn, old);
        t.bot.sendOpus(frame);
        await waitFor(() => dispatched(h.networking.wire), 1000, "dispatch on recreated connection");
      }
      t.bot.leave();
    }
  } finally { await t.bot.destroy(); }
});

it("drops a DAVE-lost turn and plays a fresh turn when DAVE returns", async () => {
  const t = testBot("slot-0", new ReceiverElection(preferredOrder(5)));
  try {
    const h = await t.join();
    t.bot.sendOpus(frame);
    await waitFor(() => dispatched(h.networking.wire), 1000, "initial dispatch");
    h.setDave({ ready: false });
    t.bot.sendOpus(frame); // observes loss synchronously and discards the old resource
    h.networking.wire.length = 0;
    await tick(30);
    assert.equal(h.networking.wire.length, 0);
    h.setDave({ ready: true });
    t.bot.sendOpus(frame);
    await waitFor(() => dispatched(h.networking.wire), 1000, "new dispatch after DAVE restoration");
    assert.equal(t.bot.rejoins, 0);
  } finally { await t.bot.destroy(); }
});

it("keeps Discord to TeamSpeak working while another sender connection is recreated", async () => {
  const f = realRuntime({ users: 2 });
  let stopTalk = () => {};
  try {
    await f.rt.start();
    await f.rt.idle();
    const receiver = f.tests.get(f.election.receiver!)!;
    const sender = f.tests.get(receiver.bot.id === "slot-0" ? "slot-1" : "slot-0")!;
    const received = receiver.latest();
    received.mapUser("human", 123);
    await tick(20);
    const opus = validOpus();
    stopTalk = talk(received, "human", () => opus);
    await waitFor(() => f.ts.out.length > 0, 1000, "Discord to TeamSpeak audio");
    const before = f.ts.out.length;
    sender.latest().conn.destroy(false);
    await waitFor(() => sender.ready.length > 1 && sender.bot.healthy, 1000, "sender rebuilt");
    assert.equal(f.election.receiver, receiver.bot.id);
    received.udp("human", opus);
    await waitFor(() => f.ts.out.length > before, 1000, "receiver continues independently");
    // Each TeamSpeak speaker still routes to their own, now live sender.
    for (const clid of [101, 102]) {
      const body = Buffer.alloc(5);
      body.writeUInt16BE(clid, 2);
      body[4] = 4;
      f.ts.emit("voice", Buffer.concat([body, frame]));
    }
    for (const id of ["slot-0", "slot-1"] as const) {
      await waitFor(() => dispatched(f.tests.get(id)!.latest().networking.wire), 1000, `${id} passthrough`);
    }
  } finally { stopTalk(); await f.cleanup(); }
});
