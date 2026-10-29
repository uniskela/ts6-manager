import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DAVESession } from "@discordjs/voice";
import { emptyDaveSnapshot, formatDaveSnapshot, noteDaveWsOut, observeDave, observeDaveWs } from "./dave-observe.js";
import { daveEnforced, readDaveInfo } from "./dave-gate.js";
import { daveSessionIdentity } from "./dave-session.js";
import { preferredOrder } from "./ids.js";
import { ReceiverElection } from "./receiver-election.js";
import { testBot } from "../testing/fake-voice.js";

function readyConn(dave: object) {
  return { state: { status: "ready", networking: { state: { code: 4, dave } } } };
}

describe("observeDave: privacy-safe MLS categories, no payloads", () => {
  it("records a failed welcome without keeping the payload", () => {
    const dave = new DAVESession(1, "1000000000000000001", "2000000000000000002", { decryptionFailureTolerance: 1 });
    dave.reinit();
    const snap = observeDave(dave);
    assert.ok(snap);
    const bad = Buffer.from([0, 0, 9, 9]);
    const result = dave.processWelcome(bad);
    assert.equal(result.success, false);
    assert.equal(snap.events.welcome, 1);
    assert.equal(snap.lastKind, "welcome");
    assert.equal(snap.lastOk, false);
    assert.equal(snap.lastTransition, 0);
    const line = formatDaveSnapshot(snap);
    assert.match(line, /welcome:fail#0/);
    assert.doesNotMatch(line, /0909|\\x|Buffer|base64/i);
    assert.ok(!Object.values(snap).some((v) => Buffer.isBuffer(v)));
  });

  it("still lets daveSessionIdentity wrap the same methods afterwards", () => {
    const dave = new DAVESession(1, "bot", "channel", {});
    (dave as unknown as { session: object }).session = {
      ready: true,
      reinit() {},
      processWelcome() {},
      getSerializedKeyPackage: () => Buffer.alloc(1),
    };
    assert.ok(observeDave(dave));
    const id = daveSessionIdentity(readyConn(dave));
    assert.ok(id);
    dave.reinit();
    assert.equal(daveSessionIdentity(readyConn(dave))?.changes, 1);
  });
});

describe("pinned davey 0.1.12 ready flag", () => {
  it("stays unready after construct and reinit: that is the live protocolVersion=1 ready=false state", () => {
    const dave = new DAVESession(1, "1000000000000000001", "2000000000000000002", {});
    dave.reinit();
    const native = (dave as unknown as { session: { ready: boolean; status: number; prepareTransition?: unknown } }).session;
    assert.equal(native.ready, false);
    assert.equal(native.status, 0, "INACTIVE until external sender + welcome/commit");
    assert.equal(typeof native.prepareTransition, "undefined", "0.1.12 has no prepareTransition");
    const info = readDaveInfo(readyConn(dave));
    assert.deepEqual(info, { protocolVersion: 1, ready: false });
    assert.equal(daveEnforced(info), false);
  });
});

describe("outbound DAVE opcodes, no payloads", () => {
  it("counts opcode 26 on sendBinaryMessage and ignores other opcodes and payloads", () => {
    const snap = emptyDaveSnapshot();
    const sent: unknown[] = [];
    const ws = {
      sendBinaryMessage(opcode: number, payload: unknown) {
        sent.push([opcode, payload]);
      },
    };
    observeDaveWs(ws, snap);
    const secret = Buffer.from("not-a-key-package");
    ws.sendBinaryMessage(26, secret);
    ws.sendBinaryMessage(4, secret);
    noteDaveWsOut(snap, 99);
    assert.deepEqual(snap.wsOut, { 26: 1 });
    assert.match(formatDaveSnapshot(snap), /wsOut=26:1/);
    assert.doesNotMatch(formatDaveSnapshot(snap), /not-a-key-package|6e6f742d/);
    assert.deepEqual(sent[0], [26, secret]);
  });
});

describe("DAVE diagnostic extras", () => {
  it("includes elapsedMs and failure count after voice Ready without payloads", async () => {
    const election = new ReceiverElection(preferredOrder(5));
    const t = testBot("slot-0", election);
    await t.join();
    const n = t.bot.daveNegotiation;
    assert.ok(n);
    assert.equal(typeof n.elapsedMs, "number");
    assert.ok((n.elapsedMs ?? -1) >= 0);
    assert.equal(n.failures, 0);
    assert.ok(!Object.values(n).some((v) => Buffer.isBuffer(v)));
    await t.bot.destroy();
  });
});
