import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { VoiceConnectionStatus } from "@discordjs/voice";
import { preferredOrder } from "../core/ids.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { isSilence, testBot, tick, waitFor } from "../testing/fake-voice.js";

const opus = (n: number) => Buffer.from([0xfc, n, n, n]);

async function twoBots() {
  const election = new ReceiverElection(preferredOrder(5));
  const sessionId = randomUUID(); // one bridge session, two bots
  const a = testBot("slot-0", election, { sessionId });
  const b = testBot("slot-1", election, { sessionId });
  const ha = await a.join();
  const hb = await b.join();
  return { election, a, b, ha, hb };
}

describe("two bots in one guild keep separate voice connections (real @discordjs/voice)", () => {
  it("creates distinct VoiceConnection objects, each signalled through its own client's adapter", async () => {
    const { a, b, ha, hb } = await twoBots();
    assert.notEqual(ha.conn, hb.conn, "the second bot must not be handed the first bot's connection");
    assert.ok(a.adapter.sent.length >= 1, "bot A used its own adapter");
    assert.ok(b.adapter.sent.length >= 1, "bot B used its own adapter, not A's");
    assert.notEqual(ha.conn.receiver, hb.conn.receiver, "separate receivers");
    await a.bot.destroy();
    await b.bot.destroy();
  });

  it("keeps a separate AudioPlayer per bot so one bot cannot replace the other's playback", async () => {
    const { a, b, ha, hb } = await twoBots();
    const pa = ha.conn.state.status === VoiceConnectionStatus.Ready ? ha.conn.state.subscription?.player : undefined;
    const pb = hb.conn.state.status === VoiceConnectionStatus.Ready ? hb.conn.state.subscription?.player : undefined;
    assert.ok(pa && pb, "both connections are subscribed to a player");
    assert.notEqual(pa, pb);

    a.bot.sendOpus(opus(1));
    await waitFor(() => ha.networking.wire.length > 0, 1000, "bot A audio on its own connection");
    await tick(60);
    assert.equal(hb.networking.wire.filter((p) => !isSilence(p)).length, 0, "bot B's connection carried none of bot A's audio");
    b.bot.sendOpus(opus(2));
    await waitFor(() => hb.networking.wire.some((p) => !isSilence(p)), 1000, "bot B audio on its own connection");
    const voiceOnA = ha.networking.wire.filter((p) => !isSilence(p));
    assert.ok(voiceOnA.length > 0 && voiceOnA.every((p) => p.includes(1) && !p.includes(2)), "bot A's wire carries only A's frames");
    await a.bot.destroy();
    await b.bot.destroy();
  });

  it("destroying one bot's connection does not destroy the other's", async () => {
    const { a, b, ha, hb } = await twoBots();
    a.bot.leave();
    assert.equal(ha.conn.state.status, VoiceConnectionStatus.Destroyed);
    assert.equal(hb.conn.state.status, VoiceConnectionStatus.Ready, "bot B's connection survives bot A leaving");
    assert.equal(b.adapter.destroyed, false);
    await a.bot.destroy();
    await b.bot.destroy();
  });

  it("uses one stable, unique group per bot across a rejoin", async () => {
    const { a, b, ha, hb } = await twoBots();
    const groupA = ha.conn.joinConfig.group;
    const groupB = hb.conn.joinConfig.group;
    assert.notEqual(groupA, "default", "never the library's shared default group");
    assert.notEqual(groupA, groupB);
    assert.ok(groupA.includes("slot-0") && groupB.includes("slot-1"), "scoped by bot identity");
    await a.join({ receive: true });
    assert.equal(a.bot.voiceConnection!.joinConfig.group, groupA, "stable across rejoin");
    await a.bot.destroy();
    await b.bot.destroy();
  });

  it("two bridge sessions in one process do not collide on the same bot id", async () => {
    const election = new ReceiverElection(preferredOrder(5));
    const s1 = testBot("slot-0", election, { sessionId: "session-one" });
    const s2 = testBot("slot-0", election, { sessionId: "session-two" });
    const h1 = await s1.join();
    const h2 = await s2.join();
    assert.notEqual(h1.conn, h2.conn);
    assert.notEqual(h1.conn.joinConfig.group, h2.conn.joinConfig.group);
    await s1.bot.destroy();
    await s2.bot.destroy();
  });
});
