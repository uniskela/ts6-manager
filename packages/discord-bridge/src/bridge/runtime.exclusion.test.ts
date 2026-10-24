import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { preferredOrder, type BotId } from "../core/ids.js";
import { createOpusCodec } from "../core/opus.js";
import { createLogger } from "../core/redact.js";
import { FakeBot, FakeTs, settle as settleRuntime } from "../testing/fake-runtime.js";
import { BridgeRuntime } from "./runtime.js";

const quiet = createLogger("test", () => undefined);

function build(excluded: Set<string>) {
  const ts = new FakeTs();
  const bots = new Map<BotId, FakeBot>();
  for (const id of preferredOrder(5)) bots.set(id, new FakeBot(id, `discord-${id}`));
  const rt = new BridgeRuntime({ ts, bots, codecFactory: () => createOpusCodec("auto"), log: quiet, excludedUniqueIds: excluded });
  return { ts, bots, rt, settle: () => settleRuntime(rt) };
}

const MUSIC = 0; // FakeTs gives user n the unique id `uid${n}`

describe("excluded TeamSpeak clients (a MusicBot) take no slot and never push a human to overflow", () => {
  it("present before the bridge starts: five humans still get five slots and nobody overflows", async () => {
    const { ts, rt, settle } = build(new Set(["uid0"]));
    ts.addUser(MUSIC, "MusicBot");
    for (let n = 1; n <= 5; n++) ts.addUser(n);
    await rt.start();
    await settle();
    assert.deepEqual(rt.status().slots, [true, true, true, true, true]);
    assert.equal(rt.status().overflowMembers, 0, "the human who joined last is not on overflow");
    assert.ok(!rt.status().inChannel.includes("overflow"));
    await rt.stop();
  });

  it("joining while the bridge runs: the same, and leaving frees nothing it never held", async () => {
    const { ts, rt, settle } = build(new Set(["uid0"]));
    await rt.start();
    ts.addUser(MUSIC, "MusicBot");
    for (let n = 1; n <= 5; n++) ts.addUser(n);
    await settle();
    assert.deepEqual(rt.status().slots, [true, true, true, true, true]);
    assert.equal(rt.status().overflowMembers, 0);
    ts.removeUser(MUSIC);
    await settle();
    assert.deepEqual(rt.status().slots, [true, true, true, true, true], "no human lost a slot when the MusicBot left");
    await rt.stop();
  });

  it("an excluded client alone does not bring a slot bot into Discord", async () => {
    const { ts, rt, settle } = build(new Set(["uid0"]));
    ts.addUser(MUSIC, "MusicBot");
    await rt.start();
    await settle();
    assert.deepEqual(rt.status().slots, [false, false, false, false, false]);
    assert.deepEqual(rt.status().inChannel, ["slot-0"], "only the idle receiver");
    await rt.stop();
  });

  it("a configuration change takes effect on refresh: newly excluded clients are released, un-excluded ones are admitted", async () => {
    const excluded = new Set<string>();
    const { ts, rt, settle } = build(excluded);
    for (let n = 0; n <= 5; n++) ts.addUser(n); // uid0 is a MusicBot nobody has declared yet
    await rt.start();
    await settle();
    assert.deepEqual(rt.status().slots, [true, true, true, true, true]);
    assert.equal(rt.status().overflowMembers, 1, "the sixth client is on overflow while uid0 holds a slot");

    excluded.add("uid0");
    await rt.refreshExclusions();
    await settle();
    assert.deepEqual(rt.status().slots, [true, true, true, true, true]);
    assert.equal(rt.status().overflowMembers, 0, "uid0's slot went to the waiting human");

    excluded.delete("uid0");
    await rt.refreshExclusions();
    await settle();
    assert.equal(rt.status().overflowMembers, 1, "un-excluded again: it takes its place behind the five humans");
    await rt.stop();
  });
});

describe("participant churn leaves no per-identity state behind", () => {
  const voice = (clid: number) => Buffer.concat([Buffer.from([0, 1, clid >> 8, clid & 0xff, 5]), Buffer.from([0xf8, 0xff, 0xfe])]);

  it("2 000 people joining, speaking and leaving keep routing evidence and decoders bounded", async () => {
    const { ts, rt, settle } = build(new Set());
    await rt.start();
    let peak = 0;
    for (let n = 1; n <= 2000; n++) {
      ts.addUser(n);
      ts.emit("voice", voice(100 + n));
      peak = Math.max(peak, rt.status().t2d.routedIdentities);
      ts.removeUser(n);
      if (n % 100 === 0) await settle();
    }
    await settle();
    assert.ok(peak >= 1, "speakers were routed, so the bound below is meaningful");
    assert.ok(peak <= 6, `routing evidence for at most the people present at once (peak ${peak})`);
    assert.equal(rt.status().t2d.routedIdentities, 0, "everyone left, nothing remains");
    assert.equal(rt.status().t2d.decoders, 0);
    await rt.stop();
  });
});
