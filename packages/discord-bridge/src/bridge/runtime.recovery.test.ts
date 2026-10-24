import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceConnectionStatus } from "@discordjs/voice";
import type { BotId } from "../core/ids.js";
import { talk, tick, waitFor, type ReadyHandle, type TestBot } from "../testing/fake-voice.js";
import { FakeBot, FakeTs } from "../testing/fake-runtime.js";
import { realRuntime, validOpus } from "../testing/real-runtime.js";
import { BridgeRuntime, type BotPort } from "./runtime.js";
import { preferredOrder } from "../core/ids.js";
import { createOpusCodec } from "../core/opus.js";
import { quietLog } from "../testing/fake-voice.js";

const joinPayloads = (t: TestBot) => t.adapter.sent.filter((p) => p.d.channel_id !== null).length;

/** Make `human` an already-speaking user on `h`, sending audio the native decoder accepts. */
function speak(h: ReadyHandle, human: string, ssrc: number) {
  const packet = validOpus();
  h.mapUser(human, ssrc);
  return talk(h, human, () => packet);
}

describe("runtime shutdown: no join survives stop() (real DiscordBot, real VoiceConnection)", () => {
  it("a target lookup that finishes after stop() does not create a connection", async () => {
    const r = realRuntime({ users: 1, stopTimeoutMs: 20 });
    const slot0 = r.tests.get("slot-0")!;
    const release = slot0.holdTarget();
    await r.rt.start();
    await tick(10); // the join is waiting on the target lookup
    await r.rt.stop();
    assert.equal(r.rt.status().state, "stopped");
    const before = joinPayloads(slot0);
    release();
    await tick(80);
    assert.equal(before, 0);
    assert.equal(joinPayloads(slot0), 0, "no voice join after the runtime reported stopped");
    assert.equal(slot0.bot.voiceConnection, null);
    assert.equal(slot0.bot.healthy, false);
    await r.cleanup();
  });

  it("a connection that completes after stop() is torn down and never becomes healthy", async () => {
    const r = realRuntime({ users: 1, stopTimeoutMs: 20, timing: { readyMs: 3000 } });
    const slot0 = r.tests.get("slot-0")!;
    slot0.autoReady = false; // the join reaches Signalling and waits
    await r.rt.start();
    await waitFor(() => slot0.bot.voiceConnection, 500, "slot-0 connection in Signalling");
    const conn = slot0.bot.voiceConnection!;
    await r.rt.stop();
    slot0.completePending(); // Discord answers after the runtime has gone
    await tick(60);
    assert.equal(slot0.bot.healthy, false);
    assert.notEqual(conn.state.status, VoiceConnectionStatus.Ready);
    assert.equal(slot0.bot.voiceConnection, null);
    await r.cleanup();
  });

  it("tears down a late join even for a bot port that cannot be cancelled", async () => {
    // A port whose join ignores leave() and finishes whenever it likes: the runtime cannot rely on the port's own fence.
    class StubbornBot extends FakeBot {
      override leave(): void {
        this.inVoice = false;
        this.healthy = false;
        this.log.push("leave");
      }
    }
    const ts = new FakeTs();
    ts.addUser(1);
    const stubborn = new StubbornBot("slot-0", "u-slot-0");
    const release = stubborn.hang();
    const bots = new Map<BotId, BotPort>(preferredOrder(5).map((id) => [id, id === "slot-0" ? stubborn : new FakeBot(id, `u-${id}`)]));
    const rt = new BridgeRuntime({ ts, bots, codecFactory: () => createOpusCodec("native"), log: quietLog, stopTimeoutMs: 10 });
    await rt.start();
    await tick(10);
    await rt.stop();
    release(); // the join completes after the runtime has stopped
    await tick(40);
    assert.equal(stubborn.inVoice, false, "the runtime left the late join's connection");
    assert.equal(stubborn.healthy, false);
  });

  it("holds for any interleaving of stop() with join completion (seeded)", async () => {
    let seed = 20261025;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let round = 0; round < 25; round++) {
      const r = realRuntime({ users: 2, stopTimeoutMs: 10 });
      const bots = [...r.tests.values()];
      const releases = bots.map((t) => t.holdTarget());
      await r.rt.start();
      const order = bots.map((_, i) => i).sort(() => rand() - 0.5);
      const stopAt = Math.floor(rand() * order.length);
      const joins = () => bots.reduce((n, t) => n + joinPayloads(t), 0);
      let atStop = -1;
      for (let i = 0; i < order.length; i++) {
        if (i === stopAt) {
          await r.rt.stop();
          atStop = joins();
        }
        releases[order[i]]();
        await tick(Math.floor(rand() * 6));
      }
      await tick(40);
      assert.equal(joins(), atStop, `round ${round}: a join was issued after the runtime was stopped`);
      for (const t of bots) {
        assert.equal(t.bot.healthy, false, `round ${round}: ${t.bot.id} is healthy after stop`);
        assert.equal(t.bot.voiceConnection, null, `round ${round}: ${t.bot.id} still holds a connection after stop`);
      }
      await r.cleanup();
    }
  });
});

describe("a failing receiver does not hold the receiver role while its fresh connection is built", () => {
  it("elects and activates a healthy successor while the failed bot's replacement connection is unresolved", async () => {
    const r = realRuntime({ users: 2, timing: { readyMs: 1500 } });
    await r.rt.start();
    await r.rt.idle();
    const failedId = r.election.receiver as BotId;
    const failed = r.tests.get(failedId)!;
    const successorId = (["slot-1", "slot-0"] as BotId[]).find((id) => id !== failedId)!;
    const successor = r.tests.get(successorId)!;
    assert.equal(successor.bot.healthy, true);

    const hf = failed.latest();
    const hs = successor.latest();
    const stopFailedTalker = speak(hf, "human-a", 1111);
    const stopSuccessorTalker = speak(hs, "human-b", 2222);
    await waitFor(() => failed.bot.openSubscriptions > 0, 1500, "the receiver is subscribed");

    failed.autoReady = false; // its replacement connection will sit in Signalling
    // Registered after the runtime's own listener, so it sees the election as the report left it.
    const atReport: { receiver: BotId | null; subs: number }[] = [];
    failed.bot.on("unhealthy", () => atReport.push({ receiver: r.election.receiver, subs: failed.bot.openSubscriptions }));
    hf.davey.decryptError = new Error("DecryptionFailed"); // poisoned DAVE session: repeated decrypt failures
    await waitFor(() => failed.bot.healthy === false, 3000, "the failed receiver is declared unhealthy");

    assert.deepEqual(atReport, [{ receiver: successorId, subs: 0 }], "the successor was elected in the same turn as the failure report, not by a later queued step");
    await waitFor(() => r.election.receiver === successorId, 400, "the healthy successor is elected without waiting for the failed bot");
    await waitFor(() => successor.bot.openSubscriptions > 0, 400, "the successor has active subscriptions");
    r.ts.out.length = 0;
    await waitFor(() => r.ts.out.length > 0, 600, "the successor's speaker reaches TeamSpeak");
    assert.equal(failed.bot.voiceConnection?.state.status, VoiceConnectionStatus.Signalling, "the failed bot's attempt is still unresolved");
    assert.equal(r.election.admitSubscribe(failedId, r.election.generation), false, "the failed bot cannot subscribe");
    assert.equal(failed.bot.openSubscriptions, 0);

    stopFailedTalker();
    // The recovery finally completes: the repaired bot comes back as a sender, not as the receiver.
    const generation = r.election.generation;
    failed.completePending();
    await waitFor(() => failed.bot.healthy, 1500, "the repaired bot is healthy again");
    await r.rt.idle();
    assert.equal(r.election.receiver, successorId, "a repaired bot does not take the receiver role back");
    assert.equal(r.election.generation, generation, "and repairing it does not disturb the current generation");
    assert.equal(failed.bot.openSubscriptions, 0, "stale callbacks cannot reopen reception on the repaired bot");
    assert.deepEqual(r.election.duplicateReceivers(), []);
    stopSuccessorTalker();
    await r.cleanup();
  });
});

describe("every reconnect entry point spends the same budget (receive failures, gateway destroy, DAVE loss, direct join, runtime retries)", () => {
  it("receive-stream errors cannot rebuild the connection past the budget, and the bot stays out until the window frees", async () => {
    const r = realRuntime({ users: 1, timing: { maxRecoveries: 1, recoveryWindowMs: 700, readyMs: 400 } });
    await r.rt.start();
    await r.rt.idle();
    const t = r.tests.get("slot-0")!;
    const errorsOn = async (h: ReadyHandle, round: number) => {
      for (let i = 0; i < 3; i++) {
        const user = `human-${round}-${i}`;
        h.mapUser(user, 100 + round * 10 + i);
        h.udp(user, Buffer.from([0xf8, 0xff, 0xfe]));
        await tick(0);
        const stream = h.conn.receiver.subscriptions.get(user);
        assert.ok(stream, "an active receive subscription");
        stream.destroy(new Error("DecryptionFailed"));
        await tick(0);
      }
    };
    await errorsOn(t.latest(), 0);
    await waitFor(() => t.ready.length === 2 && t.bot.healthy, 2000, "the one allowed rebuild");
    await r.rt.idle();
    const recoveredAt = Date.now();

    await errorsOn(t.latest(), 1);
    await waitFor(() => !t.bot.healthy, 1000, "second failure takes the bot out");
    await tick(250); // the runtime would have retried several times by now (baseMs 5)
    assert.equal(t.ready.length, 2, "no connection beyond the budget while inside the window");
    assert.equal(t.bot.healthy, false, "the bot stays out of service (fail closed)");

    // Time alone frees the budget: the runtime tries again by itself, once.
    await waitFor(() => t.ready.length === 3 && t.bot.healthy, 3000, "one attempt once the window has slid");
    assert.ok(Date.now() - recoveredAt >= 600, "not before the first rebuild left the window");
    await r.cleanup();
  });

  it("one limit across gateway destruction, receive failures, DAVE loss, direct joins and runtime retries", async () => {
    const r = realRuntime({ users: 1, timing: { maxRecoveries: 2, recoveryWindowMs: 60_000, readyMs: 300, daveGraceMs: 80 } });
    await r.rt.start();
    await r.rt.idle();
    const t = r.tests.get("slot-0")!;

    t.latest().conn.destroy(false); // entry 1: the gateway destroys the voice connection
    await waitFor(() => t.ready.length === 2 && t.bot.healthy, 2000, "rebuild 1 after gateway destruction");

    const h = t.latest(); // entry 2: poisoned DAVE session, repeated decrypt failures
    const stop = speak(h, "human", 3333);
    await waitFor(() => t.bot.openSubscriptions > 0, 1500, "subscribed");
    h.davey.decryptError = new Error("DecryptionFailed");
    await waitFor(() => t.ready.length === 3 && t.bot.healthy, 3000, "rebuild 2 after decrypt failures");
    stop();
    await r.rt.idle();

    const used = joinPayloads(t);
    t.latest().setDave({ protocolVersion: 0 }); // entry 3: DAVE lost for good (grace expires)
    await waitFor(() => !t.bot.healthy, 2000, "unhealthy after the DAVE grace window");
    await t.bot.join({ receive: false }).then(
      () => assert.fail("a direct join must not bypass the budget"), // entry 4
      (e: { code?: string }) => assert.equal(e.code, "REBUILD_BUDGET_EXHAUSTED"),
    );
    await tick(300); // entry 5: runtime retry timers keep firing
    assert.equal(t.ready.length, 3, "three connections in total: the first plus the two allowed rebuilds");
    assert.equal(joinPayloads(t), used, "no further join reached the gateway");
    assert.equal(t.bot.healthy, false);
    await r.cleanup();
  });
});
