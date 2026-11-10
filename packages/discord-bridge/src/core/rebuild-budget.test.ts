import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RebuildBudget, RebuildBudgetExhausted, isRebuildBudgetExhausted } from "./rebuild-budget.js";

describe("RebuildBudget", () => {
  it("allows `max` attempts per window and then says when the next one is allowed", () => {
    let t = 0;
    const b = new RebuildBudget(2, 1000, () => t);
    b.spend();
    t = 100;
    b.spend();
    t = 200;
    assert.throws(() => b.spend(), (e: unknown) => isRebuildBudgetExhausted(e) && (e as RebuildBudgetExhausted).retryInMs === 800);
    assert.equal(b.used, 2, "a refused attempt spends nothing");
    assert.equal(b.retryInMs(), 800);
  });

  it("recovers only as tokens leave the window, one at a time", () => {
    let t = 0;
    const b = new RebuildBudget(2, 1000, () => t);
    b.spend();
    t = 300;
    b.spend();
    t = 999;
    assert.throws(() => b.spend());
    t = 1000; // the first token expired
    b.spend();
    assert.throws(() => b.spend(), "only one slot freed");
    t = 1300;
    b.spend();
    assert.equal(b.used, 2);
  });

  it("is not a function of success: nothing refunds a token", () => {
    const b = new RebuildBudget(1, 60_000, () => 5);
    b.spend();
    // There is deliberately no API to give a token back or to reset the window.
    assert.equal(typeof (b as unknown as { reset?: unknown }).reset, "undefined");
    assert.equal(typeof (b as unknown as { refund?: unknown }).refund, "undefined");
    assert.throws(() => b.spend());
  });

  it("a budget of zero refuses everything", () => {
    const b = new RebuildBudget(0, 1000, () => 0);
    assert.throws(
      () => b.spend(),
      (e: unknown) => isRebuildBudgetExhausted(e) && e.retryInMs === 1000 && e.max === 0,
      "a finite wait, never NaN, and max=0 so the runtime can skip the wake-up",
    );
  });
});
