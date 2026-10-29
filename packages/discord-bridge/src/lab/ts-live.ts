/**
 * Bridge-D1 TeamSpeak-side live lab. Needs a TeamSpeak server on TS_LAB_HOST:TS_LAB_PORT (default
 * 127.0.0.1:9987). Speakers are SYNTHETIC TeamSpeak clients built on the same TS3 UDP client, each
 * sending a distinct tone as Opus. The Discord sinks are SIMULATED recorders. This proves the
 * TeamSpeak packet path against a real server; it does NOT replace the two-real-users proof.
 */
import { TsSession } from "../adapters/ts-session.js";
import { DiscordToTsPipeline } from "../core/discord-to-ts.js";
import { LatencyStats, ResourceSampler } from "../core/metrics.js";
import { createOpusCodec } from "../core/opus.js";
import { goertzelPower, toneFrame } from "../core/pcm.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { SlotRouter } from "../core/slot-router.js";
import { preferredOrder, type BotId } from "../core/ids.js";
import { TsToDiscordPipeline, type DiscordSendSink } from "../core/ts-to-discord.js";
import { Evidence, every20ms, sleep } from "./evidence.js";

const host = process.env.TS_LAB_HOST ?? "127.0.0.1";
const port = Number(process.env.TS_LAB_PORT ?? 9987);
const ev = new Evidence();
const sampler = new ResourceSampler();

interface Speaker {
  session: TsSession;
  freq: number;
  uniqueId: () => string | undefined;
}

/** The server's connection flood guard bans a source that connects too fast (observed: 6 joins in ~25 s from one IP); stagger joins. */
const CONNECT_GAP_MS = Number(process.env.TS_LAB_CONNECT_GAP_MS ?? 12000);
let lastConnect = 0;

async function connect(nick: string): Promise<TsSession> {
  const wait = lastConnect + CONNECT_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastConnect = Date.now();
  const s = new TsSession({ host, port, nickname: nick });
  s.on("error", () => undefined);
  await s.connect();
  return s;
}

function recorder() {
  const frames: Buffer[] = [];
  const sink: DiscordSendSink = { sendOpus: (f) => frames.push(f), endSpeech: () => undefined };
  return { frames, sink };
}

async function speakAll(speakers: Speaker[], ms: number, onSend?: (idx: number, t: number) => void): Promise<void> {
  const encs = speakers.map(() => createOpusCodec("auto"));
  const stop = every20ms((tick) => {
    speakers.forEach((sp, i) => {
      sp.session.sendVoice(encs[i].encode(toneFrame(sp.freq, tick * 960)));
      onSend?.(i, performance.now());
    });
  });
  await sleep(ms);
  stop();
  speakers.forEach((sp) => sp.session.sendVoiceStop());
  await sleep(300);
}

async function main(): Promise<void> {
  sampler.start(500);
  const bridge = await connect("d1-bridge");
  const channelId = bridge.channelId;
  ev.data.bridgeClientId = bridge.clientId;
  ev.data.channelId = channelId;

  const router = new SlotRouter(5);
  const recs = new Map<BotId, ReturnType<typeof recorder>>();
  for (const id of preferredOrder(5)) recs.set(id, recorder());
  const pipe = new TsToDiscordPipeline({
    directory: bridge.directory,
    router,
    sinks: new Map([...recs].map(([k, v]) => [k, v.sink])),
    codecFactory: () => createOpusCodec("auto"),
    channelId: () => channelId,
    ownClid: () => bridge.clientId,
  });
  const dropped = new Map<string, number>();
  const parseSamples: { clid: number; codec: number; uid: string | null }[] = [];
  const ingress = new LatencyStats();
  const sentAt: Map<number, number[]> = new Map();
  bridge.on("directory", (e: { type: string; client: { uniqueId: string; channelId: number } }) => {
    if (e.type === "enter" && e.client.channelId === channelId) router.join(e.client.uniqueId);
    if (e.type === "leave") for (const c of router.leave(e.client.uniqueId)) pipe.forget(c.uniqueId);
  });
  bridge.directory.inChannel(channelId).forEach((c) => c.clid !== bridge.clientId && router.join(c.uniqueId));
  bridge.on("voice", (data: Buffer) => {
    const now = performance.now();
    const r = pipe.onVoice(data, now);
    if (r.kind === "dropped") dropped.set(r.reason, (dropped.get(r.reason) ?? 0) + 1);
    if (parseSamples.length < 3 && data.length >= 5) {
      const clid = data.readUInt16BE(2);
      parseSamples.push({ clid, codec: data[4], uid: bridge.directory.byClientId(clid)?.uniqueId ?? null });
    }
    const q = r.kind === "slot" || r.kind === "overflow" ? sentAt.get(bridge.directory.byClientId(data.readUInt16BE(2))?.clid ?? -1) : undefined;
    const t0 = q?.shift();
    if (t0 !== undefined) ingress.record(now - t0);
  });
  const stopTick = every20ms(() => pipe.tickOverflow(performance.now()));

  // ---- Phase A: two simultaneous speakers --------------------------------------------------
  const a: Speaker[] = [];
  for (const [i, f] of [440, 1000].entries()) {
    const s = await connect(`d1-speaker-${i}`);
    a.push({ session: s, freq: f, uniqueId: () => s.directory.byClientId(s.clientId)?.uniqueId });
  }
  await sleep(1000);
  a.forEach((sp, i) => sentAt.set(sp.session.clientId, (sentAt.get(sp.session.clientId) ?? [])));
  await speakAll(a, 1500, (i, t) => sentAt.get(a[i].session.clientId)!.push(t));
  const decoded = (bot: BotId) => {
    const dec = createOpusCodec("auto");
    return Buffer.concat(recs.get(bot)!.frames.map((f) => dec.decode(f)));
  };
  const slotsUsed = [...pipe.routed.entries()].filter(([b]) => b !== "overflow");
  const perBot = slotsUsed.map(([bot, m]) => ({ bot, speakers: [...m.keys()].length, frames: [...m.values()].reduce((x, y) => x + y, 0) }));
  ev.data.phaseA = { parseSamples, perBot, dropped: Object.fromEntries(dropped) };
  ev.add({
    id: "ts-s2c-parse",
    title: "Live TS6 S2C voice packets parse to speaker CId and uniqueId",
    result: parseSamples.length > 0 && parseSamples.every((p) => p.uid) && perBot.length >= 2 ? "PASS" : "FAIL",
    provenance: "LIVE-TS6+SYNTHETIC-SPEAKERS",
    notes: `codec ids seen ${[...new Set(parseSamples.map((p) => p.codec))].join(",")}; layout VId u16 + CId u16 + codec u8 + Opus confirmed against 6.0.0-beta13`,
  });
  const bots = perBot.map((p) => p.bot).sort((a, b) => a.localeCompare(b));
  const tonePower = bots.map((bot) => ({ bot, f440: goertzelPower(decoded(bot), 440), f1000: goertzelPower(decoded(bot), 1000) }));
  const clean =
    bots.length === 2 &&
    perBot.every((p) => p.speakers === 1) &&
    tonePower.every((t) => Math.max(t.f440, t.f1000) > Math.min(t.f440, t.f1000) * 100);
  ev.data.toneIsolation = tonePower;
  ev.add({
    id: "two-speakers-two-bots",
    title: "Two simultaneous speakers routed to two separate bots, each carrying exactly one tone",
    result: clean ? "PASS" : "FAIL",
    provenance: "LIVE-TS6+SYNTHETIC-SPEAKERS",
    notes: `Discord sinks are simulated recorders. Each bot's dominant tone is >100x the other (Goertzel). Per-bot: ${JSON.stringify(perBot)}`,
  });
  ev.add({
    id: "no-duplicate",
    title: "No uniqueId delivered to more than one destination",
    result: [...pipe.routed.values()].flatMap((m) => [...m.keys()]).length === new Set([...pipe.routed.values()].flatMap((m) => [...m.keys()])).size ? "PASS" : "FAIL",
    provenance: "LIVE-TS6+SYNTHETIC-SPEAKERS",
    notes: "each speaker uniqueId appears under exactly one bot in the routing table",
  });

  // ---- Phase B: eight users, five slots + overflow ----------------------------------------
  for (const r of recs.values()) r.frames.length = 0;
  pipe.routed.clear();
  const b: Speaker[] = [...a];
  for (let i = 2; i < 8; i++) {
    const s = await connect(`d1-speaker-${i}`);
    b.push({ session: s, freq: 300 + i * 150, uniqueId: () => undefined });
  }
  await sleep(1200);
  await speakAll(b, 1500);
  const overflowMembers = router.overflowMembers().length;
  const overflowPcm = decoded("overflow");
  const presentHz = b.slice(5).map((s) => s.freq);
  const overflowOk =
    overflowMembers === 3 &&
    recs.get("overflow")!.frames.length > 0 &&
    presentHz.every((hz) => goertzelPower(overflowPcm, hz) > goertzelPower(overflowPcm, 3300) * 20);
  const slotsOk = [0, 1, 2, 3, 4].every((i) => (recs.get(`slot-${i}` as BotId)!.frames.length > 0));
  ev.data.phaseB = { overflowMembers, overflowFrames: recs.get("overflow")!.frames.length, overflowLatencyMs: pipe.overflowLatency.summary() };
  ev.add({
    id: "overflow-eight",
    title: "Eight TeamSpeak users: five slot bots plus an overflow mix of the other three",
    result: overflowOk && slotsOk ? "PASS" : "FAIL",
    provenance: "LIVE-TS6+SYNTHETIC-SPEAKERS",
    notes: `overflow members ${overflowMembers}; overflow carries tones ${presentHz.join("/")} Hz; all five slots carried audio`,
  });

  // ---- Phase C: Discord -> TeamSpeak send path into a real TS6 server ----------------------
  const listener = await connect("d1-listener");
  const heard: Buffer[] = [];
  let heardClid = -1;
  listener.on("voice", (d: Buffer) => {
    if (d.length > 5 && d[4] === 5) {
      heardClid = d.readUInt16BE(2);
      heard.push(d.subarray(5));
    }
  });
  const election = new ReceiverElection(preferredOrder(5));
  election.setState("slot-0", { healthy: true, inChannel: true });
  election.setState("slot-1", { healthy: true, inChannel: true });
  election.reconcile("lab");
  const d2t = new DiscordToTsPipeline({
    election,
    codecFactory: () => createOpusCodec("auto"),
    out: bridge,
    bridgeUserIds: () => new Set(),
  });
  const humanEnc = [createOpusCodec("auto"), createOpusCodec("auto")];
  const stopD = every20ms((tick) => {
    const now = performance.now();
    d2t.onDiscordOpus("slot-0", election.generation, "human-1", humanEnc[0].encode(toneFrame(500, tick * 960)), now);
    d2t.onDiscordOpus("slot-0", election.generation, "human-2", humanEnc[1].encode(toneFrame(1500, tick * 960)), now);
    d2t.tick(now);
  });
  await sleep(1500);
  stopD();
  await sleep(300);
  const dec = createOpusCodec("auto");
  const heardPcm = Buffer.concat(heard.map((h) => dec.decode(h)));
  ev.add({
    id: "d2t-send-path",
    title: "Mixed Discord-side audio is received by another TeamSpeak client from the one shared bridge client",
    result: heard.length > 20 && heardClid === bridge.clientId && goertzelPower(heardPcm, 500) > goertzelPower(heardPcm, 3300) * 20 && goertzelPower(heardPcm, 1500) > goertzelPower(heardPcm, 3300) * 20 ? "PASS" : "FAIL",
    provenance: "LIVE-TS6+SYNTHETIC-SPEAKERS",
    notes: `listener heard ${heard.length} frames from bridge clid ${heardClid}; both 500 Hz and 1500 Hz are in the single mix. Discord input is simulated.`,
  });
  d2t.dispose();

  stopTick();
  ev.data.ingressLatencyMs = ingress.summary();
  ev.data.resources = sampler.stop();
  ev.data.opus = createOpusCodec("auto").name;
  for (const s of [...b.map((x) => x.session), listener, bridge]) s.disconnect();
  await sleep(700);
  const file = ev.write("ts-live");
  process.stdout.write(`\nevidence: ${file}\n${JSON.stringify({ ingressLatencyMs: ev.data.ingressLatencyMs, resources: ev.data.resources, opus: ev.data.opus }, null, 2)}\n`);
  process.exit(ev.failed ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`ts-live failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
