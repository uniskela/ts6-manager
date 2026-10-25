import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { preferredOrder, type BotId } from "../core/ids.js";
import { createOpusCodec } from "../core/opus.js";
import { toneFrame } from "../core/pcm.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { createLogger } from "../core/redact.js";
import { TS_CODEC_OPUS_VOICE } from "../core/constants.js";
import { FakeBot, FakeTs, settle } from "../testing/fake-runtime.js";
import { tick, waitFor } from "../testing/fake-voice.js";
import { BridgeRuntime } from "./runtime.js";

const quiet = createLogger("test", () => undefined);

function build(o: { election?: ReceiverElection } = {}) {
  const ts = new FakeTs();
  const order: string[] = [];
  const bots = new Map<BotId, FakeBot>();
  for (const id of preferredOrder(5)) bots.set(id, new FakeBot(id, `discord-${id}`, order));
  const election = o.election ?? new ReceiverElection(preferredOrder(5));
  const rt = new BridgeRuntime({ ts, bots, election, codecFactory: () => createOpusCodec("auto"), log: quiet, retry: { baseMs: 5, maxMs: 20, maxAttempts: 3 } });
  return { ts, bots, rt, election, order };
}

describe("receiver failover is not delayed by reconnect work", () => {
  async function twoUsersThenKillReceiver() {
    const ctx = build();
    await ctx.rt.start();
    ctx.ts.addUser(1);
    ctx.ts.addUser(2);
    await settle(ctx.rt);
    const dead = ctx.rt.status().receiver as BotId;
    const oldGen = ctx.rt.status().generation;
    const releaseDead = ctx.bots.get(dead)!.hang(); // reconnecting the failed bot will hang
    ctx.order.length = 0;
    ctx.bots.get(dead)!.die();
    return { ...ctx, dead, oldGen, releaseDead };
  }

  it("activates the healthy successor while the failed bot's reconnect is still pending", async () => {
    const { bots, rt, dead, oldGen, releaseDead } = await twoUsersThenKillReceiver();
    await waitFor(() => rt.status().receiver !== null && rt.status().receiver !== dead, 500, "successor elected");
    const successor = rt.status().receiver as BotId;
    await waitFor(() => bots.get(successor)!.receiving === rt.status().generation, 500, "successor receiving while the reconnect hangs");
    assert.ok(rt.status().generation > oldGen);
    assert.equal(bots.get(dead)!.healthy, false, "the failed bot has still not come back");
    releaseDead();
    await settle(rt);
    await rt.stop();
  });

  it("activates the successor before any unrelated reconnect is attempted", async () => {
    const { rt, order, releaseDead, dead } = await twoUsersThenKillReceiver();
    await waitFor(() => order.some((e) => e.endsWith(".startReceive")), 500, "a successor started receiving");
    const firstActivation = order.findIndex((e) => e.endsWith(".startReceive"));
    const firstReconnect = order.findIndex((e) => e === `${dead}.join`);
    assert.ok(firstActivation >= 0);
    assert.ok(firstReconnect === -1 || firstActivation < firstReconnect, `activation first, got ${order.join(" > ")}`);
    releaseDead();
    await settle(rt);
    await rt.stop();
  });

  it("a pending reconnect does not hold the queue: a new TeamSpeak user still gets a bot promptly", async () => {
    const { ts, bots, rt, releaseDead } = await twoUsersThenKillReceiver();
    ts.addUser(3);
    await waitFor(() => bots.get("slot-2")!.inVoice, 500, "slot-2 joined while another reconnect hangs");
    assert.equal(bots.get("slot-2")!.nick, "[TS] User3");
    releaseDead();
    await settle(rt);
    await rt.stop();
  });

  it("preserves the receiveGeneration fence across the failover", async () => {
    const { rt, dead, oldGen, releaseDead } = await twoUsersThenKillReceiver();
    await waitFor(() => rt.status().receiver !== null && rt.status().receiver !== dead, 500, "successor");
    assert.equal(rt.election.admitFrame(dead, oldGen), false);
    assert.equal(rt.election.admitFrame(rt.status().receiver as BotId, oldGen), false);
    assert.equal(rt.status().duplicateReceivers.length, 0);
    releaseDead();
    await settle(rt);
    await rt.stop();
  });

  it("a failed reconnect is retried with a bounded backoff and then given up on", async () => {
    const { ts, bots, rt } = build();
    await rt.start();
    ts.addUser(1);
    await settle(rt);
    const b = bots.get("slot-0")!;
    b.failJoin = new Error("gateway unavailable");
    const before = b.joinCount;
    b.die();
    await waitFor(() => b.joinCount >= before + 3, 1000, "bounded retries");
    await tick(150);
    assert.equal(b.joinCount, before + 3, "it stops after maxAttempts instead of looping");
    await rt.stop();
  });
});

describe("BridgeRuntime shutdown (stopping / stopped lifecycle)", () => {
  it("never joins again after stop, even when bots report their own intentional leave as a failure", async () => {
    const { ts, bots, rt } = build();
    for (const b of bots.values()) b.emitUnhealthyOnLeave = true; // stray events during teardown
    await rt.start();
    ts.addUser(1);
    ts.addUser(2);
    await settle(rt);
    const joins = new Map([...bots].map(([id, b]) => [id, b.joinCount]));
    await rt.stop();
    await tick(60);
    for (const [id, b] of bots) assert.equal(b.joinCount, joins.get(id), `${id} did not join again after stop`);
    assert.ok([...bots.values()].every((b) => !b.inVoice), "every bot left");
  });

  it("ignores directory and bot events after stop, and removes its listeners", async () => {
    const { ts, bots, rt, election } = build();
    await rt.start();
    ts.addUser(1);
    await settle(rt);
    const electionListeners = election.listenerCount("elected") + election.listenerCount("teardown");
    await rt.stop();
    assert.equal(ts.listenerCount("voice"), 0);
    assert.equal(ts.listenerCount("directory"), 0);
    for (const b of bots.values()) assert.equal(b.listenerCount("unhealthy"), 0);
    assert.ok(election.listenerCount("elected") + election.listenerCount("teardown") < electionListeners, "election hooks removed");
    const joins = [...bots.values()].map((b) => b.joinCount);
    ts.addUser(2);
    await tick(30);
    assert.deepEqual([...bots.values()].map((b) => b.joinCount), joins);
  });

  it("cancels work that is still queued and aborts a join that is in flight, promptly", async () => {
    const { ts, bots, rt } = build();
    await rt.start();
    await settle(rt);
    const release = bots.get("slot-1")!.hang();
    ts.addUser(1);
    ts.addUser(2); // slot-1 would join and hangs
    await waitFor(() => bots.get("slot-1")!.log.some((l) => l.startsWith("join")), 500, "slot-1 join started");
    ts.addUser(3); // queued behind it
    const started = Date.now();
    await rt.stop();
    assert.ok(Date.now() - started < 1000, "stop did not wait for the hung join");
    await tick(30);
    assert.equal(bots.get("slot-2")!.joinCount, 0, "queued work never ran");
    release();
  });

  it("stops the 20 ms ticker and invalidates reception", async () => {
    const { ts, bots, rt } = build();
    await rt.start();
    ts.addUser(1);
    await settle(rt);
    const receiver = rt.status().receiver as BotId;
    const gen = rt.status().generation;
    const enc = createOpusCodec("auto");
    rt.onHumanOpus(receiver, gen, "human", enc.encode(toneFrame(440, 0)));
    await rt.stop();
    const out = ts.out.length;
    rt.onHumanOpus(receiver, gen, "human", enc.encode(toneFrame(440, 960)));
    await tick(80);
    assert.equal(ts.out.length, out, "nothing is sent to TeamSpeak after stop");
    assert.equal(bots.get(receiver)!.receiving, null);
  });

  it("is idempotent and cannot be restarted", async () => {
    const { rt } = build();
    await rt.start();
    await rt.stop();
    await rt.stop();
    assert.equal(rt.status().state, "stopped");
    await assert.rejects(() => rt.start(), /stopped/);
  });
});

describe("network callback boundary (failures the pipelines do not contain themselves)", () => {
  const brokenCodec = () => {
    throw new Error("native opus addon unavailable");
  };

  function buildBroken() {
    const ts = new FakeTs();
    const bots = new Map<BotId, FakeBot>();
    for (const id of preferredOrder(5)) bots.set(id, new FakeBot(id, `discord-${id}`));
    const rt = new BridgeRuntime({ ts, bots, codecFactory: brokenCodec, log: quiet, retry: { baseMs: 5, maxMs: 20, maxAttempts: 3 } });
    return { ts, rt };
  }

  it("a failure while handling a TeamSpeak voice packet does not throw out of the UDP callback", async () => {
    const { ts, rt } = buildBroken();
    await rt.start();
    for (let i = 1; i <= 6; i++) ts.addUser(i); // user 6 is on overflow and needs a decoder
    await settle(rt);
    const h = Buffer.alloc(5);
    h.writeUInt16BE(1, 0);
    h.writeUInt16BE(106, 2);
    h[4] = 5;
    assert.doesNotThrow(() => ts.emit("voice", Buffer.concat([h, Buffer.from([1, 2, 3])])));
    assert.equal(rt.status().callbackErrors, 1);
    await rt.stop();
  });

  it("a failure while handling a Discord frame is contained and counted", async () => {
    const { ts, rt } = buildBroken();
    await rt.start();
    ts.addUser(1);
    await settle(rt);
    assert.doesNotThrow(() => rt.onHumanOpus(rt.status().receiver as BotId, rt.status().generation, "human", Buffer.from([1, 2, 3])));
    assert.equal(rt.status().callbackErrors, 1);
    await rt.stop();
  });
});

describe("the 20 ms ticker's exception boundary (failures injected into what the ticker itself runs)", () => {
  const enc = createOpusCodec("auto");

  async function started(users: number) {
    const ctx = build();
    await ctx.rt.start();
    for (let i = 1; i <= users; i++) ctx.ts.addUser(i);
    await settle(ctx.rt);
    return ctx;
  }

  /** The elected receiver keeps sending valid Discord audio, one frame per 20 ms, until stopped. */
  function discordHumanTalks(rt: BridgeRuntime): () => void {
    let n = 0;
    const timer = setInterval(() => {
      const status = rt.status();
      rt.onHumanOpus(status.receiver as BotId, status.generation, "human", enc.encode(toneFrame(440, n++ * 960)));
    }, 20);
    return () => clearInterval(timer);
  }

  /** TeamSpeak client `clid` keeps sending valid channel voice until stopped. */
  function teamSpeakTalks(ts: FakeTs, clid: number): () => void {
    let n = 0;
    const timer = setInterval(() => {
      const header = Buffer.alloc(5);
      header.writeUInt16BE(n & 0xffff, 0);
      header.writeUInt16BE(clid, 2);
      header[4] = TS_CODEC_OPUS_VOICE;
      ts.emit("voice", Buffer.concat([header, enc.encode(toneFrame(440, n++ * 960))]));
    }, 20);
    return () => clearInterval(timer);
  }

  /** Replace `target[method]` by a function that throws on its first call and delegates afterwards. */
  function failOnce<T extends object>(target: T, method: keyof T & string, error: Error): { fired: () => boolean } {
    const original = (target[method] as unknown as (...a: unknown[]) => unknown).bind(target);
    let fired = false;
    (target as Record<string, unknown>)[method] = (...args: unknown[]) => {
      if (!fired) {
        fired = true;
        throw error;
      }
      return original(...args);
    };
    return { fired: () => fired };
  }

  it("a throw from the Discord-to-TeamSpeak tick is counted, the runtime stays up, and later audio is still sent", async () => {
    const { ts, rt } = await started(1);
    const stopTalking = discordHumanTalks(rt);
    try {
      const failure = failOnce(rt.d2t, "tick", new Error("injected: d2t.tick"));
      await waitFor(() => failure.fired(), 1500, "the ticker to run the injected failure");
      await waitFor(() => rt.status().callbackErrors === 1, 500, "the failure to be counted");
      assert.equal(rt.status().state, "running");
      const sentAtFailure = ts.out.length;
      await waitFor(() => ts.out.length >= sentAtFailure + 3, 1500, "valid audio to reach TeamSpeak after the failure");
      assert.equal(rt.status().callbackErrors, 1, "one injected failure, one counted error, no further errors");
    } finally {
      stopTalking();
      await rt.stop();
    }
  });

  it("a throw from the TeamSpeak-to-Discord overflow tick is counted, the runtime stays up, and later overflow audio is still sent", async () => {
    const { ts, bots, rt } = await started(6); // the sixth person is on overflow
    const stopTalking = teamSpeakTalks(ts, 106);
    try {
      const failure = failOnce(rt.t2d, "tickOverflow", new Error("injected: t2d.tickOverflow"));
      await waitFor(() => failure.fired(), 1500, "the ticker to run the injected failure");
      await waitFor(() => rt.status().callbackErrors === 1, 500, "the failure to be counted");
      assert.equal(rt.status().state, "running");
      const sentAtFailure = bots.get("overflow")!.sent.length;
      await waitFor(() => bots.get("overflow")!.sent.length >= sentAtFailure + 3, 1500, "valid overflow audio to reach the overflow bot after the failure");
      assert.equal(rt.status().callbackErrors, 1);
    } finally {
      stopTalking();
      await rt.stop();
    }
  });

  it("a TeamSpeak transport that throws while the tick sends is counted, and the next frames are sent", async () => {
    const { ts, rt } = await started(1);
    const stopTalking = discordHumanTalks(rt);
    try {
      const failure = failOnce(ts, "sendVoice", new Error("injected: sendVoice"));
      await waitFor(() => failure.fired(), 1500, "the tick to try to send");
      await waitFor(() => rt.status().callbackErrors === 1, 500, "the failure to be counted");
      assert.equal(rt.status().state, "running");
      const sentAtFailure = ts.out.length;
      await waitFor(() => ts.out.length >= sentAtFailure + 3, 1500, "later frames to reach TeamSpeak");
      assert.equal(rt.status().callbackErrors, 1);
    } finally {
      stopTalking();
      await rt.stop();
    }
  });
});

describe("the 20 ms ticker has one exception boundary per direction (a direction that keeps failing does not stop the other)", () => {
  const enc = createOpusCodec("auto");

  function built(log = quiet) {
    const ts = new FakeTs();
    const bots = new Map<BotId, FakeBot>();
    for (const id of preferredOrder(5)) bots.set(id, new FakeBot(id, `discord-${id}`, []));
    const rt = new BridgeRuntime({ ts, bots, election: new ReceiverElection(preferredOrder(5)), codecFactory: () => createOpusCodec("auto"), log, retry: { baseMs: 5, maxMs: 20, maxAttempts: 3 } });
    return { ts, bots, rt };
  }

  /** Replace `target[method]` by one that throws on every call, and count the calls. */
  function failAlways<T extends object>(target: T, method: keyof T & string): { calls: () => number } {
    let calls = 0;
    (target as Record<string, unknown>)[method] = () => {
      calls += 1;
      throw new Error(`injected: ${method} fails every time`);
    };
    return { calls: () => calls };
  }

  function every20ms(fn: (n: number) => void): () => void {
    let n = 0;
    const timer = setInterval(() => fn(n++), 20);
    return () => clearInterval(timer);
  }

  const tsVoice = (clid: number, n: number) => {
    const header = Buffer.alloc(5);
    header.writeUInt16BE(n & 0xffff, 0);
    header.writeUInt16BE(clid, 2);
    header[4] = TS_CODEC_OPUS_VOICE;
    return Buffer.concat([header, enc.encode(toneFrame(440, n * 960))]);
  };

  it("an overflow tick that throws on every tick does not stop Discord audio reaching TeamSpeak", async () => {
    const { ts, rt } = built();
    await rt.start();
    for (let i = 1; i <= 6; i++) ts.addUser(i);
    await settle(rt);
    const broken = failAlways(rt.t2d, "tickOverflow");
    const stop = every20ms((n) => {
      const s = rt.status();
      rt.onHumanOpus(s.receiver as BotId, s.generation, "human", enc.encode(toneFrame(440, n * 960)));
    });
    try {
      const sentBefore = ts.out.length;
      await waitFor(() => broken.calls() >= 15 && ts.out.length >= sentBefore + 10, 3000, "Discord audio to keep reaching TeamSpeak while the overflow tick keeps failing");
      assert.equal(rt.status().state, "running");
      const errors = rt.status().tickErrors;
      assert.ok(errors.tsToDiscord >= 15, `every overflow failure is counted (${errors.tsToDiscord})`);
      assert.equal(errors.discordToTs, 0, "and none is blamed on the other direction");
    } finally {
      stop();
      await rt.stop();
    }
  });

  it("a Discord-to-TeamSpeak mix tick that throws on every tick does not stop TeamSpeak audio reaching the overflow bot", async () => {
    const { ts, bots, rt } = built();
    await rt.start();
    for (let i = 1; i <= 6; i++) ts.addUser(i); // the sixth person is on overflow
    await settle(rt);
    const broken = failAlways(rt.d2t, "tick");
    const stop = every20ms((n) => ts.emit("voice", tsVoice(106, n)));
    try {
      const overflow = bots.get("overflow")!;
      const sentBefore = overflow.sent.length;
      await waitFor(() => broken.calls() >= 15 && overflow.sent.length >= sentBefore + 10, 3000, "overflow audio to keep reaching Discord while the mix tick keeps failing");
      assert.equal(rt.status().state, "running");
      const errors = rt.status().tickErrors;
      assert.ok(errors.discordToTs >= 15, `every mix failure is counted (${errors.discordToTs})`);
      assert.equal(errors.tsToDiscord, 0);
    } finally {
      stop();
      await rt.stop();
    }
  });

  it("failures on every tick in both directions are counted in full, logged a bounded number of times, and stop with the runtime", async () => {
    const lines: string[] = [];
    const { ts, rt } = built(createLogger("test", (l) => lines.push(l)));
    await rt.start();
    ts.addUser(1);
    await settle(rt);
    const t2d = failAlways(rt.t2d, "tickOverflow");
    const d2t = failAlways(rt.d2t, "tick");
    try {
      await waitFor(() => t2d.calls() >= 40 && d2t.calls() >= 40, 4000, "forty failing ticks in each direction");
    } finally {
      await rt.stop();
    }
    const { tsToDiscord, discordToTs } = rt.status().tickErrors;
    assert.equal(tsToDiscord, t2d.calls(), "each overflow failure counted once");
    assert.equal(discordToTs, d2t.calls(), "each mix failure counted once");
    const logged = (site: string) => lines.filter((l) => l.includes(site)).length;
    // The first five at each site, then one line each time that site's count reaches a power of two.
    const bound = (n: number) => 5 + Math.max(0, Math.floor(Math.log2(n)) - 2);
    assert.ok(logged("TeamSpeak to Discord overflow") <= bound(tsToDiscord), `overflow lines ${logged("TeamSpeak to Discord overflow")} for ${tsToDiscord} failures`);
    assert.ok(logged("Discord to TeamSpeak mix") <= bound(discordToTs), `mix lines ${logged("Discord to TeamSpeak mix")} for ${discordToTs} failures`);
    assert.ok(logged("TeamSpeak to Discord overflow") >= 5 && logged("Discord to TeamSpeak mix") >= 5, "the first failures at each site are logged");
    assert.ok(lines.every((l) => !l.includes("    at ")), "no stack traces in the log");
    const after = [t2d.calls(), d2t.calls()];
    await tick(100);
    assert.deepEqual([t2d.calls(), d2t.calls()], after, "after stop() the ticker runs neither direction");
  });
});
