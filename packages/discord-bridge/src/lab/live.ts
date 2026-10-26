/**
 * Bridge-D1 live runner: the real bridge with six official Discord bots and one shared TeamSpeak
 * client. It needs authorised bot tokens, a Discord guild/voice channel, and a TeamSpeak server with
 * human participants (see README). Without them it prints the missing requirements and exits 2.
 * It never invents a result: human-observed checks are recorded only when the operator attests them
 * with `mark <check-id> pass|fail <note>`.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { DiscordBot } from "../adapters/discord-bot.js";
import { TsSession } from "../adapters/ts-session.js";
import { BridgeRuntime, type BotPort } from "../bridge/runtime.js";
import { preferredOrder, type BotId } from "../core/ids.js";
import { ResourceSampler } from "../core/metrics.js";
import { createOpusCodec } from "../core/opus.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { createLogger, safeError } from "../core/redact.js";
import { loadLabConfig, presenceReport } from "./config.js";
import { Evidence } from "./evidence.js";

const log = createLogger("d1-live");
const loaded = loadLabConfig(process.env);

if (!loaded.ok) {
  process.stdout.write("Bridge-D1 live run NOT started. Missing requirements (SET/MISSING only):\n");
  for (const [k, v] of Object.entries(presenceReport(process.env))) process.stdout.write(`  ${k}: ${v}\n`);
  for (const p of loaded.problems) process.stdout.write(`  problem: ${p}\n`);
  process.stdout.write("No live result is recorded. Live checks stay NOT-RUN.\n");
  process.exit(2);
}

const cfg = loaded.config;
const ev = new Evidence();
const sampler = new ResourceSampler();
const ids = preferredOrder(5);
const attested: { id: string; result: string; note: string; at: string }[] = [];

async function main(): Promise<void> {
  const ts = new TsSession({ host: cfg.ts.host, port: cfg.ts.port, nickname: "ts6-bridge-d1", channel: cfg.ts.channel, serverPassword: cfg.ts.password });
  ts.on("error", (e: Error) => log.warn(`ts error: ${safeError(e)}`));
  await ts.connect();

  let runtime: BridgeRuntime | null = null;
  const election = new ReceiverElection(ids);
  const bots = new Map<BotId, BotPort>();
  const concrete = new Map<BotId, DiscordBot>();
  const sessionId = randomUUID(); // scopes every bot's voice connection group to this bridge session
  for (const id of ids) {
    const bot = new DiscordBot({
      id,
      token: cfg.tokens[id],
      guildId: cfg.guildId,
      channelId: cfg.channelId,
      election,
      log,
      sessionId,
      onHumanOpus: (b, g, u, o, a) => runtime?.onHumanOpus(b, g, u, o, a),
      onHumanClosed: (b, u) => runtime?.onHumanClosed(b, u),
      bridgeUserIds: () => new Set([...concrete.values()].map((c) => c.userId).filter(Boolean)),
    });
    concrete.set(id, bot);
    bots.set(id, bot);
  }
  runtime = new BridgeRuntime({ ts, bots, election, codecFactory: () => createOpusCodec("auto"), log });

  // Fail closed: every identity must log in and pass the guild/channel permission check first.
  const bad: string[] = [];
  for (const [id, bot] of concrete) {
    try {
      await bot.login();
      const v = await bot.verify();
      if (!v.ok) bad.push(`${id}: ${v.reason}`);
    } catch (e) {
      bad.push(`${id}: login failed (${safeError(e)})`);
    }
  }
  const userIds = [...concrete.values()].map((b) => b.userId);
  if (new Set(userIds).size !== userIds.length) bad.push("two tokens belong to the same Discord application");
  if (bad.length) {
    log.error(`not starting, fail closed: ${bad.join("; ")}`);
    for (const b of concrete.values()) await b.destroy().catch(() => undefined);
    ts.disconnect();
    process.exit(3);
  }

  sampler.start(1000);
  await runtime.start();
  log.info("bridge running. Commands: status | kill-receiver | mark <id> pass|fail <note> | write | quit");

  const snapshot = () => ({
    ...runtime!.status(),
    dave: Object.fromEntries([...concrete].map(([id, b]) => [id, b.daveInfo])),
    receiveSubscriptions: Object.fromEntries([...concrete].map(([id, b]) => [id, b.openSubscriptions])),
    decryptErrors: Object.fromEntries([...concrete].map(([id, b]) => [id, b.decryptErrors])),
    recoveries: Object.fromEntries([...concrete].map(([id, b]) => [id, b.rejoins])),
    identityLookups: Object.fromEntries([...concrete].map(([id, b]) => [id, b.identityLookups])),
  });

  const rl = createInterface({ input: process.stdin });
  const finish = async (code: number) => {
    ev.data.finalStatus = snapshot();
    ev.data.resources = sampler.stop();
    ev.data.operatorAttested = attested;
    for (const a of attested) {
      ev.add({ id: a.id, title: "operator-attested live check", result: a.result === "pass" ? "PASS" : "FAIL", provenance: "LIVE", notes: a.note });
    }
    process.stdout.write(`evidence: ${ev.write("live")}\n`);
    await runtime!.stop();
    for (const b of concrete.values()) await b.destroy().catch(() => undefined);
    ts.disconnect();
    process.exit(code);
  };
  rl.on("line", (line) => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    if (cmd === "status") process.stdout.write(`${JSON.stringify(snapshot(), null, 2)}\n`);
    else if (cmd === "kill-receiver") {
      const r = runtime!.election.receiver;
      if (r) {
        log.info(`killing receiver ${r} (generation ${runtime!.election.generation})`);
        concrete.get(r)!.kill("operator kill");
      }
    } else if (cmd === "mark" && rest.length >= 2) attested.push({ id: rest[0], result: rest[1], note: rest.slice(2).join(" "), at: new Date().toISOString() });
    else if (cmd === "write") ev.data.snapshot = snapshot();
    else if (cmd === "quit") void finish(0);
  });
  process.on("SIGINT", () => void finish(0));
  process.on("SIGTERM", () => void finish(0));
}

main().catch((e) => {
  log.error(`live run failed: ${safeError(e)}`);
  process.exit(1);
});
