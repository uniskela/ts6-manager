import { DEFAULT_SLOT_COUNT } from "./constants.js";
import { slotBotId, type BotId } from "./ids.js";

export type Destination = BotId;

export interface SlotChange {
  uniqueId: string;
  from: Destination | null;
  to: Destination | null;
}

/**
 * Maps TeamSpeak uniqueIds to exactly one Discord destination: an individual slot bot or the
 * overflow bot. A uniqueId has at most one destination at any time, so it can never be audible on
 * a slot and on overflow together. Slots are held while the uniqueId stays in the channel.
 */
export class SlotRouter {
  private readonly slots: (string | null)[];
  private readonly overflow = new Set<string>();
  /** Join order of uniqueIds waiting on overflow, used to promote when a slot frees. */
  private readonly waiting: string[] = [];

  constructor(private readonly slotCount = DEFAULT_SLOT_COUNT) {
    this.slots = Array.from({ length: slotCount }, () => null);
  }

  /** Add a uniqueId to the channel. Idempotent. */
  join(uniqueId: string): SlotChange[] {
    if (this.destinationFor(uniqueId)) return [];
    const free = this.slots.indexOf(null);
    if (free >= 0) {
      this.slots[free] = uniqueId;
      return [{ uniqueId, from: null, to: slotBotId(free) }];
    }
    this.overflow.add(uniqueId);
    this.waiting.push(uniqueId);
    return [{ uniqueId, from: null, to: "overflow" }];
  }

  /** Remove a uniqueId. A freed slot promotes the longest-waiting overflow uniqueId. */
  leave(uniqueId: string): SlotChange[] {
    const changes: SlotChange[] = [];
    const idx = this.slots.indexOf(uniqueId);
    if (idx >= 0) {
      this.slots[idx] = null;
      changes.push({ uniqueId, from: slotBotId(idx), to: null });
      const next = this.waiting.shift();
      if (next) {
        // Remove from the old destination before adding to the new one, in one step.
        this.overflow.delete(next);
        this.slots[idx] = next;
        changes.push({ uniqueId: next, from: "overflow", to: slotBotId(idx) });
      }
    } else if (this.overflow.delete(uniqueId)) {
      const w = this.waiting.indexOf(uniqueId);
      if (w >= 0) this.waiting.splice(w, 1);
      changes.push({ uniqueId, from: "overflow", to: null });
    }
    return changes;
  }

  destinationFor(uniqueId: string): Destination | null {
    const idx = this.slots.indexOf(uniqueId);
    if (idx >= 0) return slotBotId(idx);
    return this.overflow.has(uniqueId) ? "overflow" : null;
  }

  slotOccupant(index: number): string | null {
    return this.slots[index] ?? null;
  }

  overflowMembers(): string[] {
    return [...this.overflow];
  }

  occupiedSlots(): number {
    return this.slots.filter((s) => s !== null).length;
  }

  /** True when the bot should be in the Discord channel (it carries at least one uniqueId). */
  botCarriesAudio(bot: BotId): boolean {
    if (bot === "overflow") return this.overflow.size > 0;
    const i = Number(bot.slice(5));
    return this.slots[i] != null;
  }
}
