/**
 * Dependency smoke for the worker image: native Opus, native DAVE and @discordjs/voice must load and
 * work on the running Node. This is a build gate, not a live receive proof. A missing native DAVE
 * addon is fatal: there is no DAVE-less fallback.
 */
import { createRequire } from "node:module";
import { generateDependencyReport } from "@discordjs/voice";
import { createOpusCodec } from "../core/opus.js";
import { goertzelPower, toneFrame } from "../core/pcm.js";
import { Evidence } from "./evidence.js";

const require = createRequire(import.meta.url);
const ev = new Evidence();
const report = generateDependencyReport();

function opusRoundTrip(kind: "native" | "opusscript"): string {
  const codec = createOpusCodec(kind);
  const enc = codec.encode(toneFrame(1000, 0));
  const frames: Buffer[] = [];
  const dec = createOpusCodec(kind);
  for (let i = 0; i < 10; i++) frames.push(dec.decode(codec.encode(toneFrame(1000, i * 960))));
  const pcm = Buffer.concat(frames);
  if (!(goertzelPower(pcm, 1000) > goertzelPower(pcm, 3300) * 100)) throw new Error("tone lost in round trip");
  return `${codec.name}, ${enc.length}-byte packets, 1 kHz survives a 10-frame round trip`;
}

function attempt(id: string, title: string, fn: () => string, notes = ""): void {
  try {
    ev.add({ id, title, result: "PASS", provenance: "NATIVE-DEPS", notes: fn() || notes });
  } catch (e) {
    ev.add({ id, title, result: "FAIL", provenance: "NATIVE-DEPS", notes: e instanceof Error ? e.message : String(e) });
  }
}

attempt("node", `Node ${process.version}`, () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) throw new Error(`worker image must run Node 24, found ${process.version}`);
  return `v${process.versions.node}, abi ${process.versions.modules}`;
});
attempt("native-opus", "Native @discordjs/opus loads and round-trips", () => opusRoundTrip("native"));
attempt("opusscript", "opusscript fallback loads and round-trips", () => opusRoundTrip("opusscript"));
attempt("native-dave", "Native @snazzah/davey loads and creates an MLS key package", () => {
  const davey = require("@snazzah/davey") as { DAVE_PROTOCOL_VERSION: number; DAVESession: new (v: number, user: string, channel: string) => { getSerializedKeyPackage(): Buffer } };
  const session = new davey.DAVESession(davey.DAVE_PROTOCOL_VERSION, "1000000000000000001", "2000000000000000002");
  const kp = session.getSerializedKeyPackage();
  if (!kp?.length) throw new Error("empty key package");
  return `DAVE protocol v${davey.DAVE_PROTOCOL_VERSION}, key package ${kp.length} bytes`;
});
attempt("voice-report", "@discordjs/voice dependency report shows DAVE + Opus + native AES-256-GCM", () => {
  for (const needle of ["@snazzah/davey:", "@discordjs/opus:", "aes-256-gcm: yes"]) {
    if (!report.includes(needle)) throw new Error(`report is missing "${needle}"`);
  }
  if (/@snazzah\/davey: not found/.test(report)) throw new Error("DAVE library not found");
  return report.split("\n").filter((l) => /^- /.test(l) && !/not found/.test(l)).join("; ");
});

ev.data.dependencyReport = report;
const file = ev.write("smoke-deps");
process.stdout.write(`\nevidence: ${file}\n`);
process.exit(ev.failed ? 1 : 0);
