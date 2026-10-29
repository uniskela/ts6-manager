/**
 * Container probe for the evidence bind mount. No Discord, no TeamSpeak, no secrets.
 * Writes a privacy-safe detailed status (0600) and a minimal host-status (0644).
 */
import { buildBetaStatus, pushEvent, writeBetaStatusFiles, type BetaEvent } from "./beta-status.js";

const dir = process.env.D1_EVIDENCE_DIR || "evidence";
const events: BetaEvent[] = [];
pushEvent(events, "starting");

const snap = {
  state: "running" as const,
  receiver: "slot-0",
  generation: 1,
  scheduledReconnects: 0,
  duplicateReceivers: [],
  dave: { "slot-0": { protocolVersion: 1, ready: true } },
  decryptErrors: { "slot-0": 0 },
  daveReplacements: { "slot-0": 0 },
  recoveries: { "slot-0": 0 },
  d2t: { framesSent: 0, daveDropped: 0, admissionDropped: 0, selfSourceDrops: 0 },
};

writeBetaStatusFiles(
  dir,
  buildBetaStatus({ sourceCommit: process.env.D1_SOURCE_COMMIT || "probe", snap, events, started: true, singleAttempt: true }),
);

const finish = () => {
  pushEvent(events, "stopping");
  writeBetaStatusFiles(
    dir,
    buildBetaStatus({
      sourceCommit: process.env.D1_SOURCE_COMMIT || "probe",
      snap: { ...snap, state: "stopped" },
      events,
      started: true,
      singleAttempt: true,
    }),
  );
  process.exit(0);
};
process.on("SIGTERM", finish);
process.on("SIGINT", finish);
setInterval(() => undefined, 60_000);
