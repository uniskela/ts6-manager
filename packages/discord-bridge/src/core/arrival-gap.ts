import { ARRIVAL_GAP_MS } from "./constants.js";

/**
 * Last-arrival times for gap counting. The caller must delete a key on voice-stop, forget and
 * dispose so the map stays bounded by who is speaking now.
 */
export function noteArrivalGap(last: Map<string, number>, id: string, nowMs: number, gapMs = ARRIVAL_GAP_MS): boolean {
  const prev = last.get(id);
  last.set(id, nowMs);
  return prev !== undefined && nowMs - prev > gapMs;
}
