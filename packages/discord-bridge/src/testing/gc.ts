/**
 * Test helper: a full garbage collection on demand, without starting node with --expose-gc.
 *
 * Reachability tests use it with `WeakRef`: after `collect()`, a WeakRef whose target is still
 * there is held by something. A target that is gone was reclaimable. The reverse is not proof of a
 * leak on its own (a conservative collector may keep an object), so tests pair it with structural
 * assertions (who still holds a subscription) and never depend on finalization timing.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

export async function collect(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    gc();
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** How many of these weak references still have a target after a full collection. */
export async function alive(refs: readonly WeakRef<object>[]): Promise<number> {
  await collect();
  return refs.filter((r) => r.deref() !== undefined).length;
}
