import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DAVESession } from "@discordjs/voice";
import { DaveSessionEpochs, daveSessionIdentity } from "./dave-session.js";

/** A connection shaped like a Ready `VoiceConnection`, around the library's real DAVESession wrapper. */
function readyConnection() {
  const native = { ready: true, reinit() {}, reset() {}, setPassthroughMode() {}, getSerializedKeyPackage: () => Buffer.alloc(1), processWelcome() {} };
  const dave = new DAVESession(1, "bot", "channel", {});
  (dave as unknown as { session: object }).session = native;
  const networking = { state: { code: 4, dave } };
  const conn = { state: { status: "ready", networking } as { status: string; networking: unknown } };
  return { conn, networking, dave, native };
}

describe("daveSessionIdentity and DaveSessionEpochs: which DAVE session is in force", () => {
  it("one session keeps one epoch; a new Networking, wrapper, native session, reinit or welcome is a new one", () => {
    const { conn, networking, dave } = readyConnection();
    const epochs = new DaveSessionEpochs();
    const first = epochs.of(daveSessionIdentity(conn));
    assert.equal(first, 1);
    assert.equal(epochs.of(daveSessionIdentity(conn)), 1, "the same session, read again");

    dave.reinit(); // the library's own in-place re-initialisation: same objects
    assert.equal(epochs.of(daveSessionIdentity(conn)), 2);
    (dave as unknown as { processWelcome(p: Buffer): unknown }).processWelcome(Buffer.from([0, 0]));
    assert.equal(epochs.of(daveSessionIdentity(conn)), 3, "joining a group by welcome");

    (dave as unknown as { session: object }).session = { ready: true };
    assert.equal(epochs.of(daveSessionIdentity(conn)), 4, "a different native session");

    const other = readyConnection();
    networking.state.dave = other.dave;
    assert.equal(epochs.of(daveSessionIdentity(conn)), 5, "a different wrapper");

    conn.state.networking = other.networking;
    assert.equal(epochs.of(daveSessionIdentity(conn)), 6, "a different Networking");
    assert.equal(epochs.latest, 6);
  });

  it("an epoch never comes back: A, B, then A again is a third epoch", () => {
    const a = readyConnection();
    const b = readyConnection();
    const epochs = new DaveSessionEpochs();
    assert.equal(epochs.of(daveSessionIdentity(a.conn)), 1);
    assert.equal(epochs.of(daveSessionIdentity(b.conn)), 2);
    assert.equal(epochs.of(daveSessionIdentity(a.conn)), 3);
    epochs.forget();
    assert.equal(epochs.of(daveSessionIdentity(a.conn)), 4, "after forget(), whatever is seen next is new");
  });

  it("counts a re-initialisation before it runs, so a check made during it already sees a new session", () => {
    const { conn, dave, native } = readyConnection();
    const epochs = new DaveSessionEpochs();
    epochs.of(daveSessionIdentity(conn));
    let during: number | null = null;
    native.reinit = () => {
      during = epochs.of(daveSessionIdentity(conn));
    };
    dave.reinit();
    assert.equal(during, 2);
  });

  it("instruments a wrapper once: one reinit is one change however often the session is read", () => {
    const { conn, dave } = readyConnection();
    for (let i = 0; i < 5; i++) daveSessionIdentity(conn);
    dave.reinit();
    assert.equal(daveSessionIdentity(conn)?.changes, 1);
  });

  it("fails closed: no identity when not ready, when a part is missing, or when the wrapper cannot be instrumented", () => {
    const notReady = readyConnection();
    notReady.conn.state.status = "connecting";
    assert.equal(daveSessionIdentity(notReady.conn), null);

    const noNative = readyConnection();
    (noNative.dave as unknown as { session: unknown }).session = undefined;
    assert.equal(daveSessionIdentity(noNative.conn), null);

    const noDave = readyConnection();
    (noDave.networking.state as { dave: unknown }).dave = null;
    assert.equal(daveSessionIdentity(noDave.conn), null);

    for (const lock of [Object.freeze, Object.seal, Object.preventExtensions]) {
      const locked = readyConnection();
      lock(locked.dave);
      assert.equal(daveSessionIdentity(locked.conn), null, `${lock.name}: cannot be instrumented`);
    }

    const pinned = readyConnection();
    Object.defineProperty(pinned.dave, "reinit", { value: () => undefined, configurable: false, writable: false });
    assert.equal(daveSessionIdentity(pinned.conn), null, "a reinit that cannot be wrapped");
    assert.equal(new DaveSessionEpochs().of(null), null);
  });
});

describe("daveSessionIdentity with the real native davey session", () => {
  it("an in-place reinit of the library's DAVESession keeps the same native object, and is still a new epoch", () => {
    const dave = new DAVESession(1, "158049329150427136", "1234567890123456789", {});
    dave.reinit(); // creates the real native @snazzah/davey session
    const native = dave.session;
    assert.ok(native, "a native session exists");
    const conn = { state: { status: "ready", networking: { state: { code: 4, dave } } } };
    const epochs = new DaveSessionEpochs();
    assert.equal(epochs.of(daveSessionIdentity(conn)), 1);
    dave.reinit();
    assert.equal(dave.session, native, "the library re-initialises the native session in place: object identity alone cannot see it");
    assert.equal(epochs.of(daveSessionIdentity(conn)), 2, "the counted reinit does");
  });
});
