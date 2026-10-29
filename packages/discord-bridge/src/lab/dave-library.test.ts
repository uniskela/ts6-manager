/**
 * Exercises the REAL @discordjs/voice@0.19.2 DAVESession wrapper with a stand-in for the native
 * davey session. It reproduces the mechanism behind discordjs/discord.js#11653 in the pinned
 * version without a Discord connection. It is library-behaviour evidence, not a live DAVE proof.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DAVESession } from "@discordjs/voice";

type Fake = { ready: boolean; reinitCalls: number; canPassthrough: () => boolean; decrypt: () => Buffer; reinit: () => void; getSerializedKeyPackage: () => Buffer; processWelcome: () => void };

function makeSession(tolerance: number) {
  const dave = new DAVESession(1, "bot-user", "channel", { decryptionFailureTolerance: tolerance });
  const fake: Fake = {
    ready: true,
    reinitCalls: 0,
    canPassthrough: () => false,
    decrypt: () => {
      throw new Error("UnencryptedWhenPassthroughDisabled");
    },
    reinit() {
      this.reinitCalls += 1;
    },
    getSerializedKeyPackage: () => Buffer.alloc(1),
    processWelcome: () => undefined,
  };
  (dave as unknown as { session: Fake }).session = fake;
  return { dave, fake };
}

const packet = Buffer.from([1, 2, 3, 4]);

describe("DAVESession decrypt recovery in @discordjs/voice@0.19.2", () => {
  it("reproduces #11653: after a welcome at transition 0, persistent decrypt failures throw instead of recovering", () => {
    const { dave } = makeSession(2);
    dave.processWelcome(Buffer.from([0, 0, 9, 9])); // transition id 0
    assert.equal(dave.lastTransitionId, 0);
    let thrown: Error | null = null;
    for (let i = 0; i < 4 && !thrown; i++) {
      try {
        dave.decrypt(packet, "human");
      } catch (e) {
        thrown = e as Error;
      }
    }
    assert.match(thrown?.message ?? "", /UnencryptedWhenPassthroughDisabled/);
  });

  it("recovers by re-initialising when the last transition id is non-zero", () => {
    const { dave, fake } = makeSession(2);
    dave.processWelcome(Buffer.from([0, 7, 9, 9])); // transition id 7, pending
    (dave as unknown as { lastTransitionId: number }).lastTransitionId = 7;
    (dave as unknown as { pendingTransitions: Map<number, number> }).pendingTransitions.clear();
    let invalidated: number | null = null;
    dave.on("invalidateTransition", (id: number) => (invalidated = id));
    for (let i = 0; i < 4; i++) assert.doesNotThrow(() => dave.decrypt(packet, "human"));
    assert.equal(invalidated, 7);
    assert.ok(fake.reinitCalls >= 1);
  });

  it("returns audio untouched on a protocol-0 (non-DAVE) session, which is why the bridge enforces DAVE itself", () => {
    const dave = new DAVESession(0, "bot-user", "channel", {});
    let decryptCalls = 0;
    (dave as unknown as { session: object }).session = {
      ready: true,
      canPassthrough: () => true,
      decrypt: (_u: string, _t: number, p: Buffer) => (decryptCalls++, p), // davey passthrough returns the packet as-is
    };
    assert.deepEqual(dave.decrypt(packet, "human"), packet, "plaintext accepted at protocol 0");
    assert.equal(decryptCalls, 1);
    // Send side: encrypt is a no-op at protocol 0, so a non-DAVE channel gets plaintext media.
    assert.deepEqual(dave.encrypt(packet), packet);
  });
});
