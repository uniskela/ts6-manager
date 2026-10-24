/**
 * Participant-churn memory check with the REAL native Opus decoder. Tens of thousands of distinct Discord
 * users speak briefly and leave. Decoders must be released (stream close, or the idle sweep when no
 * close is reported), so live decoders stay bounded and RSS stops growing once warmed up.
 * Native finalizers only run on event-loop turns, so the loop yields; a fully synchronous version of
 * this script shows ~1 GB of RSS growth that is a measurement artifact (heap stays flat, and the
 * addon destructor frees the state once the loop turns). Run with `pnpm churn` (needs --expose-gc). Native-codec evidence, not live Discord evidence.
 */
import { ClientDirectory } from "../core/client-directory.js";
import { DiscordToTsPipeline } from "../core/discord-to-ts.js";
import { preferredOrder } from "../core/ids.js";
import { createOpusCodec } from "../core/opus.js";
import { toneFrame } from "../core/pcm.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { SlotRouter } from "../core/slot-router.js";
import { TsToDiscordPipeline } from "../core/ts-to-discord.js";
import { Evidence } from "./evidence.js";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) {
  process.stderr.write("run with --expose-gc (pnpm churn)\n");
  process.exit(2);
}
const ev = new Evidence();
const CYCLES = Number(process.env.CHURN_CYCLES ?? 40_000);
/** RSS climbs for the first ~20 000 cycles (allocator warm-up) and then plateaus; growth is measured after that. */
const WARMUP = Math.floor(CYCLES / 2);
const FRAMES_PER_USER = 5;
const MB = 1024 * 1024;
/**
 * A decoder that is never released costs tens of KB of native memory (about 47 KB measured), so a
 * leak over the post-warm-up window would be hundreds of MB. Steady-state RSS also steps by tens of
 * MB at random (allocator arenas), so the limit sits between the two and the 10% trend is recorded
 * for a human to read: two 200 000-cycle runs plateaued at 148-154 MB and 132-135 MB.
 */
const RSS_LIMIT_MB = 64;

function build() {
  const election = new ReceiverElection(preferredOrder(5));
  election.setState("slot-0", { healthy: true, inChannel: true });
  election.reconcile("churn");
  let created = 0;
  let disposed = 0;
  const pipe = new DiscordToTsPipeline({
    election,
    codecFactory: () => {
      created += 1;
      const real = createOpusCodec("native");
      return { ...real, dispose: () => void disposed++ };
    },
    out: { sendVoice: () => undefined, sendVoiceStop: () => undefined },
    bridgeUserIds: () => new Set(),
  });
  return { election, pipe, live: () => created - disposed, created: () => created };
}

const turn = () => new Promise<void>((r) => setImmediate(r));

/**
 * N-API finalizers (which free the native decoder state) run on later event-loop turns, never inside
 * a synchronous loop, so the sample yields after each forced GC before it reads memory.
 */
async function sample(): Promise<{ rssMB: number; heapMB: number }> {
  for (let i = 0; i < 3; i++) {
    gc!();
    await turn();
  }
  const m = process.memoryUsage();
  return { rssMB: Math.round((m.rss / MB) * 10) / 10, heapMB: Math.round((m.heapUsed / MB) * 10) / 10 };
}

async function churn(name: string, withClose: boolean) {
  const { election, pipe, live, created } = build();
  const packet = createOpusCodec("native").encode(toneFrame(440, 0));
  const marks: { cycle: number; liveDecoders: number; rssMB: number; heapMB: number }[] = [];
  const trend: { cycle: number; rssMB: number }[] = [];
  let now = 0;
  for (let i = 1; i <= CYCLES; i++) {
    const user = `user-${i}`; // a brand new participant every cycle
    for (let f = 0; f < FRAMES_PER_USER; f++) {
      pipe.onDiscordOpus("slot-0", election.generation, user, packet, now);
      now += 20;
      pipe.tick(now);
    }
    if (withClose) pipe.releaseUser(user); // the receive stream closed
    if (i % 250 === 0) await turn(); // a real bridge yields constantly; let finalizers run
    if (i % Math.floor(CYCLES / 10) === 0 && i !== WARMUP && i !== CYCLES) trend.push({ cycle: i, rssMB: (await sample()).rssMB });
    if (i === WARMUP || i === CYCLES) marks.push({ cycle: i, liveDecoders: live(), ...(await sample()) });
  }
  const growthRss = Math.round((marks[1].rssMB - marks[0].rssMB) * 10) / 10;
  const growthHeap = Math.round((marks[1].heapMB - marks[0].heapMB) * 10) / 10;
  return { name, withClose, cycles: CYCLES, decodersCreated: created(), marks, trend, growthRssMB: growthRss, growthHeapMB: growthHeap, finalLive: live(), pipelineDecoders: pipe.decoderCount };
}

/**
 * The TeamSpeak to Discord direction: a new person joins the overflow, speaks for a moment and leaves,
 * tens of thousands of times. Their decoder and routing evidence must go with them, and dispose() must be terminal.
 */
async function churnTs() {
  const directory = new ClientDirectory();
  const router = new SlotRouter(5);
  let created = 0;
  let disposed = 0;
  let sent = 0; // a count, not the frames: keeping 40 000 packets alive would itself look like a leak
  const sinks = new Map(["overflow", "slot-0", "slot-1", "slot-2", "slot-3", "slot-4"].map((id) => [id as never, { sendOpus: () => void sent++, endSpeech: () => undefined }]));
  const pipe = new TsToDiscordPipeline({
    directory,
    router,
    sinks,
    codecFactory: () => {
      created += 1;
      const real = createOpusCodec("native");
      return { ...real, dispose: () => void disposed++ };
    },
    channelId: () => 1,
    ownClid: () => 99,
  });
  const enter = (clid: number, uid: string) => {
    directory.ingest({ name: "notifycliententerview", params: { ctid: "1", clid: String(clid), client_unique_identifier: uid, client_nickname: uid } });
    router.join(uid);
  };
  for (let i = 0; i < 5; i++) enter(10 + i, `resident-${i}`); // the five slots are taken
  const packet = createOpusCodec("native").encode(toneFrame(440, 0));
  const header = (clid: number) => Buffer.from([0, 1, clid >> 8, clid & 0xff, 5]);
  const marks: { cycle: number; rssMB: number; heapMB: number }[] = [];
  let now = 0;
  let peakRouted = 0;
  for (let i = 1; i <= CYCLES; i++) {
    const uid = `overflow-guest-${i}`;
    enter(20, uid);
    for (let f = 0; f < FRAMES_PER_USER; f++) {
      pipe.onVoice(Buffer.concat([header(20), packet]), now);
      now += 20;
      pipe.tickOverflow(now);
    }
    peakRouted = Math.max(peakRouted, pipe.routedIdentities);
    for (const c of router.leave(uid)) pipe.forget(c.uniqueId);
    directory.ingest({ name: "notifyclientleftview", params: { clid: "20" } });
    if (i % 250 === 0) await turn();
    if (i === WARMUP || i === CYCLES) marks.push({ cycle: i, ...(await sample()) });
  }
  const before = created;
  const liveBeforeDispose = created - disposed;
  pipe.dispose();
  const sentBefore = sent;
  pipe.onVoice(Buffer.concat([header(10), packet]), now);
  pipe.tickOverflow(now + 20);
  return {
    cycles: CYCLES,
    codecsCreated: before,
    liveBeforeDispose,
    liveAfterDispose: created - disposed,
    createdAfterDispose: created - before,
    sentAfterDispose: sent - sentBefore,
    peakRoutedIdentities: peakRouted,
    finalRoutedIdentities: pipe.routedIdentities,
    decoders: pipe.decoderCount,
    growthRssMB: Math.round((marks[1].rssMB - marks[0].rssMB) * 10) / 10,
    growthHeapMB: Math.round((marks[1].heapMB - marks[0].heapMB) * 10) / 10,
    marks,
  };
}

const closed = await churn("stream-close", true);
const swept = await churn("idle-sweep-only", false);
const ts = await churnTs();
ev.data.churn = [closed, swept];
ev.data.churnTs = ts;
ev.add({
  id: "churn-release-on-close",
  title: `Native decoders are released when streams close (${CYCLES} distinct participants)`,
  result: closed.finalLive <= 1 && closed.pipelineDecoders === 0 && closed.growthRssMB < RSS_LIMIT_MB ? "PASS" : "FAIL",
  provenance: "NATIVE-DEPS",
  notes: `per-user decoders at the end ${closed.pipelineDecoders}, live native codecs ${closed.finalLive} (the one shared encoder); RSS grew ${closed.growthRssMB} MB and heap ${closed.growthHeapMB} MB after a ${WARMUP}-cycle warm-up, over the next ${CYCLES - WARMUP} cycles`,
});
ev.add({
  id: "churn-idle-sweep",
  title: "With no close notification, idle sweep and the decoder cap keep live decoders bounded",
  result: swept.finalLive <= 257 && swept.pipelineDecoders <= 256 && swept.growthRssMB < RSS_LIMIT_MB ? "PASS" : "FAIL",
  provenance: "NATIVE-DEPS",
  notes: `live decoders at the end ${swept.finalLive} (cap 256, idle 5 s); RSS grew ${swept.growthRssMB} MB and heap ${swept.growthHeapMB} MB after a ${WARMUP}-cycle warm-up, over the next ${CYCLES - WARMUP} cycles`,
});
ev.add({
  id: "churn-ts-to-discord",
  title: `TeamSpeak to Discord: overflow speakers coming and going (${CYCLES} distinct people) leave no decoder or routing state, and dispose is terminal`,
  result:
    ts.peakRoutedIdentities <= 6 &&
    ts.finalRoutedIdentities === 0 &&
    ts.decoders === 0 &&
    ts.liveAfterDispose === 0 &&
    ts.createdAfterDispose === 0 &&
    ts.sentAfterDispose === 0 &&
    ts.growthRssMB < RSS_LIMIT_MB
      ? "PASS"
      : "FAIL",
  provenance: "NATIVE-DEPS",
  notes: `peak routing entries ${ts.peakRoutedIdentities}, final ${ts.finalRoutedIdentities}; decoders ${ts.decoders}; live codecs before dispose ${ts.liveBeforeDispose}, after ${ts.liveAfterDispose}; codecs created after dispose ${ts.createdAfterDispose}, frames sent after dispose ${ts.sentAfterDispose}; RSS grew ${ts.growthRssMB} MB and heap ${ts.growthHeapMB} MB after a ${WARMUP}-cycle warm-up`,
});
process.stdout.write(`${JSON.stringify([...(ev.data.churn as unknown[]), ts], null, 2)}\nevidence: ${ev.write("churn")}\n`);
process.exit(ev.failed ? 1 : 0);
