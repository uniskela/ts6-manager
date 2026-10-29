/**
 * Bridge-D1 private-beta runner. Separate from the laboratory stdin procedure.
 * Requires D1_RUNTIME_MODE=private-beta. Writes a privacy-safe status file. No audio, tokens or keys.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DiscordBot } from "../adapters/discord-bot.js";
import { TsSession } from "../adapters/ts-session.js";
import { BridgeRuntime, type BotPort } from "../bridge/runtime.js";
import { preferredOrder, type BotId } from "../core/ids.js";
import { ResourceSampler } from "../core/metrics.js";
import { createOpusCodec } from "../core/opus.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { createLogger, safeError } from "../core/redact.js";
import {
  botsOnlyParkGrant,
  connectedParkBots,
  buildBetaStatus,
  diffEvents,
  pushEvent,
  writeBetaStatusFiles,
  type BetaEvent,
  type BetaSnapshotIn,
} from "./beta-status.js";
import { labDaveDiagnostic, loadLabConfig, presenceReport, requireRuntimeMode } from "./config.js";
import { Evidence } from "./evidence.js";

const log = createLogger("d1-private-beta");
const mode = requireRuntimeMode(process.env, "private-beta");
if (!mode.ok) {
  process.stdout.write(`Bridge-D1 private-beta NOT started: ${mode.problem}\n`);
  process.stdout.write("This entry is the experimental private-beta runtime only.\n");
  process.exit(2);
}

const loaded = loadLabConfig(process.env);
if (!loaded.ok) {
  process.stdout.write("Bridge-D1 private-beta NOT started. Missing requirements (SET/MISSING only):\n");
  for (const [k, v] of Object.entries(presenceReport(process.env))) process.stdout.write(`  ${k}: ${v}\n`);
  for (const p of loaded.problems) process.stdout.write(`  problem: ${p}\n`);
  process.exit(2);
}

const cfg = loaded.config;
const diag = labDaveDiagnostic(process.env);
const ev = new Evidence();
const sampler = new ResourceSampler();
const ids = preferredOrder(5);
const events: BetaEvent[] = [];
const sourceCommit = process.env.D1_SOURCE_COMMIT || "unknown";
const evidenceDir = join(process.cwd(), "evidence");

async function main(): Promise<void> {
  pushEvent(events, "starting", { sourceCommit });
  log.info(`mode=private-beta experimental=true sourceCommit=${sourceCommit}`);

  const ts = new TsSession({
    host: cfg.ts.host,
    port: cfg.ts.port,
    nickname: "ts6-bridge-d1-beta",
    channel: cfg.ts.channel,
    serverPassword: cfg.ts.password,
  });
  ts.on("error", (e: Error) => log.warn(`ts error: ${safeError(e)}`));
  await ts.connect();

  let runtime: BridgeRuntime | null = null;
  const election = new ReceiverElection(ids);
  const bots = new Map<BotId, BotPort>();
  const concrete = new Map<BotId, DiscordBot>();
  const sessionId = randomUUID();
  for (const id of ids) {
    const bot = new DiscordBot({
      id,
      token: cfg.tokens[id],
      guildId: cfg.guildId,
      channelId: cfg.channelId,
      election,
      log,
      sessionId,
      timing: diag.timing,
      onHumanOpus: (b, g, u, o, a) => runtime?.onHumanOpus(b, g, u, o, a),
      onHumanClosed: (b, u) => runtime?.onHumanClosed(b, u),
      bridgeUserIds: () => new Set([...concrete.values()].map((c) => c.userId).filter(Boolean)),
    });
    concrete.set(id, bot);
    bots.set(id, bot);
  }
  if (diag.singleAttempt) log.info("single-attempt: first planned join only; no automatic reconnects");

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

  runtime = new BridgeRuntime({ ts, bots, election, codecFactory: () => createOpusCodec("auto"), log, retry: diag.retry });
  sampler.start(1000);
  await runtime.start();
  pushEvent(events, "bridge_running");
  log.info("private-beta running. Status file: evidence/private-beta-status.json. SIGTERM/SIGINT to stop.");

  const byBot = <T>(pick: (b: DiscordBot) => T) => Object.fromEntries([...concrete].map(([id, b]) => [id, pick(b)]));
  const snapshot = (): BetaSnapshotIn => {
    const occupancy = [...concrete.values()].reduce(
      (acc, b) => (b.channelOccupancy.members > acc.members ? b.channelOccupancy : acc),
      { members: 0, bots: 0 },
    );
    const st = runtime!.status();
    const present = new Set(st.inChannel);
    return {
      ...st,
      dave: byBot((b) => b.daveInfo),
      decryptErrors: byBot((b) => b.decryptErrors),
      daveReplacements: byBot((b) => b.daveReplacements),
      recoveries: byBot((b) => b.rejoins),
      tsTransport: { whisperDropped: ts.whisperDropped },
      senders: byBot((b) => ({
        daveReady: b.daveInfo?.ready === true && (b.daveInfo.protocolVersion ?? 0) >= 1,
        framesSent: b.framesSent,
        playerStatus: b.playerStatus,
        playbackDropped: b.playbackDropped,
        playbackStarved: b.playbackStarved,
        playbackHealthRejected: b.playbackHealthRejected,
        playbackDaveRejected: b.playbackDaveRejected,
        healthy: b.healthy,
        inChannel: present.has(b.id),
      })),
      voiceMembers: occupancy.members,
      voiceBots: occupancy.bots,
      botsOnlyPark: botsOnlyParkGrant(st.receiver, connectedParkBots(concrete.values())),
    };
  };

  let prev: BetaSnapshotIn | null = null;
  const publish = () => {
    const snap = snapshot();
    const added = diffEvents(prev, snap, events);
    for (const e of added) log.info(`event ${e.kind}`);
    prev = snap;
    writeBetaStatusFiles(
      evidenceDir,
      buildBetaStatus({ sourceCommit, snap, events, started: true, singleAttempt: diag.singleAttempt }),
    );
  };
  publish();
  const tick = setInterval(publish, 5_000);
  tick.unref();

  let finishing = false;
  const finish = async (code: number) => {
    if (finishing) return;
    finishing = true;
    clearInterval(tick);
    pushEvent(events, "stopping");
    const snap = snapshot();
    ev.data.mode = "private-beta";
    ev.data.sourceCommit = sourceCommit;
    ev.data.finalStatus = buildBetaStatus({
      sourceCommit,
      snap,
      events,
      started: true,
      singleAttempt: diag.singleAttempt,
    });
    ev.data.resources = sampler.stop();
    writeBetaStatusFiles(
      evidenceDir,
      buildBetaStatus({ sourceCommit, snap, events, started: true, singleAttempt: diag.singleAttempt }),
    );
    process.stdout.write(`evidence: ${ev.write("private-beta")}\n`);
    await runtime!.stop();
    pushEvent(events, "stopped");
    for (const b of concrete.values()) await b.destroy().catch(() => undefined);
    ts.disconnect();
    process.exit(code);
  };
  process.on("SIGINT", () => void finish(0));
  process.on("SIGTERM", () => void finish(0));
}

main().catch((e) => {
  log.error(`private-beta failed: ${safeError(e)}`);
  process.exit(1);
});
