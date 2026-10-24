import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { ClientDirectory } from "../core/client-directory.js";
import { preferredOrder, type BotId } from "../core/ids.js";
import { tsNickname } from "../core/nickname.js";
import { createOpusCodec } from "../core/opus.js";
import { toneFrame } from "../core/pcm.js";
import { createLogger } from "../core/redact.js";
import { BridgeRuntime, type BotPort } from "./runtime.js";

const quiet = createLogger("test", () => undefined);

class FakeBot extends EventEmitter implements BotPort {
  healthy = false;
  deaf = true;
  inVoice = false;
  receiving: number | null = null;
  nick: string | null = null;
  sent: Buffer[] = [];
  log: string[] = [];
  constructor(readonly id: BotId, readonly userId: string) {
    super();
  }
  async join(o: { receive: boolean }) {
    this.inVoice = true;
    this.healthy = true;
    this.deaf = !o.receive;
    this.log.push(`join(receive=${o.receive})`);
  }
  leave() {
    this.inVoice = false;
    this.healthy = false;
    this.receiving = null;
    this.log.push("leave");
  }
  async setNickname(n: string | null) {
    this.nick = n;
  }
  startReceive(g: number) {
    this.receiving = g;
    this.log.push(`startReceive(${g})`);
    return true;
  }
  stopReceive() {
    this.receiving = null;
    this.log.push("stopReceive");
  }
  sendOpus(f: Buffer) {
    this.sent.push(f);
  }
  endSpeech() {}
  /** Simulates the Discord connection dying. */
  die() {
    this.healthy = false;
    this.inVoice = false;
    this.receiving = null;
    this.emit("unhealthy", "connection lost");
  }
}

class FakeTs extends EventEmitter {
  directory = new ClientDirectory();
  clientId = 1;
  channelId = 1;
  out: Buffer[] = [];
  stops = 0;
  sendVoice(o: Buffer) {
    this.out.push(o);
  }
  sendVoiceStop() {
    this.stops++;
  }
  addUser(n: number, name = `User${n}`) {
    const params = { ctid: "1", clid: String(100 + n), client_unique_identifier: `uid${n}`, client_nickname: name };
    for (const ev of this.directory.ingest({ name: "notifycliententerview", params })) this.emit("directory", ev);
  }
  removeUser(n: number) {
    for (const ev of this.directory.ingest({ name: "notifyclientleftview", params: { clid: String(100 + n) } })) this.emit("directory", ev);
  }
}

async function build() {
  const ts = new FakeTs();
  const bots = new Map<BotId, FakeBot>();
  for (const id of preferredOrder(5)) bots.set(id, new FakeBot(id, `discord-${id}`));
  const rt = new BridgeRuntime({ ts, bots, codecFactory: () => createOpusCodec("auto"), log: quiet });
  const settle = () => rt.enqueue(async () => undefined).then(() => rt.enqueue(async () => undefined));
  return { ts, bots, rt, settle };
}

describe("BridgeRuntime idle-overflow and receiver rules (simulated Discord, orchestration level)", () => {
  it("0 TeamSpeak users: only slot 0 is in Discord as the receiver and keeps its application name", async () => {
    const { bots, rt, settle } = await build();
    await rt.start();
    await settle();
    assert.deepEqual(rt.status().inChannel, ["slot-0"]);
    assert.equal(rt.status().receiver, "slot-0");
    assert.equal(bots.get("slot-0")!.nick, null);
    assert.equal(bots.get("overflow")!.inVoice, false);
    assert.equal(bots.get("slot-0")!.receiving, rt.status().generation);
    await rt.stop();
  });

  it("1-5 TeamSpeak users: those slot bots join as [TS] Username and overflow stays out", async () => {
    const { ts, bots, rt, settle } = await build();
    await rt.start();
    ts.addUser(1, "Alice");
    ts.addUser(2, "Bob");
    await settle();
    assert.deepEqual(rt.status().inChannel, ["slot-0", "slot-1"]);
    assert.equal(bots.get("slot-0")!.nick, "[TS] Alice");
    assert.equal(bots.get("slot-1")!.nick, "[TS] Bob");
    assert.equal(bots.get("overflow")!.inVoice, false);
    assert.equal(rt.status().duplicateReceivers.length, 0);
    await rt.stop();
  });

  it("6th user brings in [TS] Others and receive moves to overflow with teardown first; it moves back before overflow leaves", async () => {
    const { ts, bots, rt, settle } = await build();
    await rt.start();
    for (let i = 1; i <= 5; i++) ts.addUser(i);
    await settle();
    const gen5 = rt.status().generation;
    assert.equal(rt.status().receiver, "slot-0");
    ts.addUser(6);
    await settle();
    assert.equal(bots.get("overflow")!.nick, "[TS] Others");
    assert.equal(rt.status().receiver, "overflow");
    assert.ok(rt.status().generation > gen5);
    assert.equal(bots.get("slot-0")!.receiving, null, "old receiver dropped its subscriptions");
    assert.ok(bots.get("slot-0")!.log.includes("stopReceive"));
    assert.equal(bots.get("overflow")!.deaf, false, "overflow joined undeafened to receive");
    assert.equal(bots.get("overflow")!.receiving, rt.status().generation);

    ts.removeUser(6);
    await settle();
    assert.equal(rt.status().receiver !== "overflow", true);
    assert.equal(bots.get("overflow")!.inVoice, false, "[TS] Others left once empty");
    assert.equal(bots.get("overflow")!.nick, null);
    assert.equal(rt.status().inChannel.includes("overflow"), false);
    const log = bots.get("overflow")!.log;
    assert.ok(log.indexOf("stopReceive") < log.lastIndexOf("leave"), "receive moved off overflow before it left");
    await rt.stop();
  });

  it("killing the receiver elects exactly one successor and the old bot cannot resubscribe", async () => {
    const { ts, bots, rt, settle } = await build();
    await rt.start();
    ts.addUser(1);
    ts.addUser(2);
    await settle();
    const dead = rt.status().receiver!;
    const oldGen = rt.status().generation;
    bots.get(dead)!.die();
    await settle();
    const s = rt.status();
    assert.notEqual(s.receiver, null);
    assert.notEqual(s.receiver, dead);
    assert.ok(s.generation > oldGen);
    assert.equal(s.duplicateReceivers.length, 0);
    const receivers = [...bots.values()].filter((b) => b.receiving !== null);
    assert.equal(receivers.length, 1, "exactly one bot holds human subscriptions");
    assert.equal(rt.election.admitSubscribe(dead as BotId, oldGen), false);
    await rt.stop();
  });

  it("killing the receiver mid-speech: stale frames fenced, TeamSpeak hears one copy per tick", async () => {
    const { ts, bots, rt, settle } = await build();
    await rt.start();
    ts.addUser(1);
    ts.addUser(2);
    await settle();
    const dead = rt.status().receiver!;
    const oldGen = rt.status().generation;
    const enc = createOpusCodec("auto");
    for (let f = 0; f < 3; f++) rt.onHumanOpus(dead, oldGen, "human", enc.encode(toneFrame(440, f * 960)), );
    bots.get(dead)!.die();
    await settle();
    const successor = rt.status().receiver!;
    const gen = rt.status().generation;
    const before = ts.out.length;
    for (let f = 3; f < 8; f++) {
      rt.onHumanOpus(dead, oldGen, "human", enc.encode(toneFrame(440, f * 960))); // late callbacks from the dead bot
      rt.onHumanOpus(successor, gen, "human", enc.encode(toneFrame(440, f * 960)));
      rt.d2t.tick(f * 20);
    }
    assert.equal(ts.out.length - before, 5, "one mixed frame per tick");
    assert.ok(rt.status().election.fenceDrops >= 5);
    await rt.stop();
  });

  it("a non-receiver slot failure does not move receive and leaves the other slots running", async () => {
    const { ts, bots, rt, settle } = await build();
    await rt.start();
    for (let i = 1; i <= 3; i++) ts.addUser(i);
    await settle();
    const receiver = rt.status().receiver;
    const gen = rt.status().generation;
    bots.get("slot-2")!.die();
    await settle();
    assert.equal(rt.status().receiver, receiver);
    assert.equal(rt.status().generation, gen);
    assert.equal(bots.get("slot-1")!.inVoice, true);
    await rt.stop();
  });

  it("no healthy bot left: Discord to TeamSpeak fails closed while other slots keep sending", async () => {
    const { ts, bots, rt, settle } = await build();
    await rt.start();
    ts.addUser(1);
    await settle();
    const gen = rt.status().generation;
    bots.get("slot-0")!.die();
    await settle();
    assert.equal(rt.election.admitFrame("slot-0", gen), false);
    await rt.stop();
  });
});

describe("tsNickname", () => {
  it("keeps the [TS] prefix and truncates the name to 32 UTF-16 units", () => {
    assert.equal(tsNickname("Alice"), "[TS] Alice");
    const long = tsNickname("x".repeat(60));
    assert.equal(long.length, 32);
    assert.ok(long.startsWith("[TS] "));
  });
  it("never splits a surrogate pair at the cut", () => {
    const n = tsNickname("a".repeat(26) + "😀");
    assert.ok(n.length <= 32);
    assert.ok(!/[\ud800-\udbff]$/.test(n));
  });
  it("falls back for an empty name", () => {
    assert.equal(tsNickname("   "), "[TS] Unknown");
  });
});
