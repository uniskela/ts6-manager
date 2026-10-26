/**
 * A BridgeRuntime around six REAL DiscordBot instances (real @discordjs/voice connections, players,
 * receivers and DAVE wrapper, faked network edge) and a fake TeamSpeak. Used by the lifecycle tests,
 * where the failures that matter are between the runtime and the adapter, not inside either alone.
 * Simulated Discord evidence, never live.
 */
import { randomUUID } from "node:crypto";
import type { BotTiming } from "../adapters/discord-bot.js";
import { BridgeRuntime, type BotPort, type RetryPolicy } from "../bridge/runtime.js";
import { preferredOrder, type BotId } from "../core/ids.js";
import { createOpusCodec } from "../core/opus.js";
import { toneFrame } from "../core/pcm.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { FakeTs } from "./fake-runtime.js";
import { quietLog, testBot, type TestBot } from "./fake-voice.js";

/** A packet the native decoder accepts, for tests where audio goes all the way to TeamSpeak. */
export const validOpus = (): Buffer => createOpusCodec("native").encode(toneFrame(440, 0));

export function realRuntime(
  o: { users?: number; timing?: Partial<BotTiming>; retry?: Partial<RetryPolicy>; stopTimeoutMs?: number; now?: () => number } = {},
) {
  const election = new ReceiverElection(preferredOrder(5));
  const ts = new FakeTs();
  for (let i = 1; i <= (o.users ?? 2); i++) ts.addUser(i);
  const sessionId = randomUUID();
  let rt!: BridgeRuntime;
  const tests = new Map<BotId, TestBot>(
    preferredOrder(5).map((id) => [
      id,
      testBot(id, election, {
        sessionId,
        timing: o.timing,
        now: o.now,
        onHumanOpus: (b, g, u, op, a) => rt.onHumanOpus(b, g, u, op, a),
        onHumanClosed: (b, u) => rt.onHumanClosed(b, u),
      }),
    ]),
  );
  const bots = new Map<BotId, BotPort>([...tests].map(([id, t]) => [id, t.bot]));
  rt = new BridgeRuntime({
    ts,
    bots,
    election,
    codecFactory: () => createOpusCodec("native"),
    log: quietLog,
    stopTimeoutMs: o.stopTimeoutMs ?? 200,
    retry: { baseMs: 5, maxMs: 50, maxAttempts: 5, ...o.retry },
  });
  return {
    rt,
    ts,
    election,
    tests,
    async cleanup() {
      await rt.stop();
      for (const t of tests.values()) await t.bot.destroy();
    },
  };
}
