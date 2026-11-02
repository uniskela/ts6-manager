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
 *
 * Ineligible (refused/unhealthy) slots are never assigned. An occupant on a slot that becomes
 * ineligible is moved to another eligible slot with capacity, or dropped fail-closed.
 */
export class SlotRouter {
  private readonly slots: (string | null)[];
  private readonly overflow = new Set<string>();
  /** Join order of uniqueIds waiting on overflow, used to promote when a slot frees. */
  private readonly waiting: string[] = [];
  private readonly ineligible = new Set<number>();
  private overflowEligible = true;
  /** Still in the TeamSpeak channel, but with no usable Discord destination. */
  private readonly unavailable = new Set<string>();

  constructor(private readonly slotCount = DEFAULT_SLOT_COUNT) {
    this.slots = Array.from({ length: slotCount }, () => null);
  }

  slotEligible(index: number): boolean {
    return index >= 0 && index < this.slots.length && !this.ineligible.has(index);
  }

  isUnavailable(uniqueId: string): boolean {
    if (this.unavailable.has(uniqueId)) return true;
    const idx = this.slots.indexOf(uniqueId);
    return idx >= 0 && !this.slotEligible(idx);
  }

  unavailableOccupants(): string[] {
    const ids = [...this.unavailable];
    for (let i = 0; i < this.slots.length; i++) {
      const uid = this.slots[i];
      if (uid && !this.slotEligible(i)) ids.push(uid);
    }
    return ids;
  }

  /** Occupants dropped fail-closed, not those still sitting on an ineligible slot. */
  hasUnroutedOccupants(): boolean {
    return this.unavailable.size > 0;
  }

  /** Mark a slot usable or not. Ineligible slots keep their occupant until `evictIneligible()`. */
  setSlotEligible(index: number, eligible: boolean): SlotChange[] {
    if (index < 0 || index >= this.slots.length) return [];
    const was = this.slotEligible(index);
    if (was === eligible) return [];
    if (eligible) {
      this.ineligible.delete(index);
      return this.fillFreeSlots();
    }
    this.ineligible.add(index);
    return [];
  }

  /** Move occupants off ineligible slots, or drop them fail-closed. */
  evictIneligible(): SlotChange[] {
    const changes: SlotChange[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slotEligible(i)) continue;
      changes.push(...this.evictSlot(i));
    }
    return changes;
  }

  setOverflowEligible(eligible: boolean): SlotChange[] {
    if (this.overflowEligible === eligible) return [];
    this.overflowEligible = eligible;
    if (eligible) return this.restoreUnavailable();
    const changes: SlotChange[] = [];
    for (const uniqueId of [...this.waiting]) {
      this.overflow.delete(uniqueId);
      const w = this.waiting.indexOf(uniqueId);
      if (w >= 0) this.waiting.splice(w, 1);
      const placed = this.assignEligible(uniqueId);
      if (placed) changes.push({ uniqueId, from: "overflow", to: placed });
      else {
        this.markUnavailable(uniqueId);
        changes.push({ uniqueId, from: "overflow", to: null });
      }
    }
    return changes;
  }

  /** Add a uniqueId to the channel. Idempotent. Never assigns an ineligible slot. */
  join(uniqueId: string): SlotChange[] {
    if (this.slots.includes(uniqueId) || this.overflow.has(uniqueId)) return [];
    // Already fail-closed in this channel: restore onto a slot if one is free, never overflow.
    if (this.unavailable.has(uniqueId)) return this.fillFreeSlots();
    const prior = this.fillFreeSlots();
    const placed = this.assignEligible(uniqueId);
    if (placed) return [...prior, { uniqueId, from: null, to: placed }];
    if (this.overflowEligible) {
      this.overflow.add(uniqueId);
      this.waiting.push(uniqueId);
      return [...prior, { uniqueId, from: null, to: "overflow" }];
    }
    this.markUnavailable(uniqueId);
    return [...prior, { uniqueId, from: null, to: null }];
  }

  /** Remove a uniqueId. Free capacity goes to unavailable occupants, then overflow, then later arrivals. */
  leave(uniqueId: string): SlotChange[] {
    this.unavailable.delete(uniqueId);
    const changes: SlotChange[] = [];
    const idx = this.slots.indexOf(uniqueId);
    if (idx >= 0) {
      this.slots[idx] = null;
      changes.push({ uniqueId, from: slotBotId(idx), to: null });
      changes.push(...this.fillFreeSlots());
    } else if (this.overflow.delete(uniqueId)) {
      const w = this.waiting.indexOf(uniqueId);
      if (w >= 0) this.waiting.splice(w, 1);
      changes.push({ uniqueId, from: "overflow", to: null });
    }
    return changes;
  }

  destinationFor(uniqueId: string): Destination | null {
    const idx = this.slots.indexOf(uniqueId);
    if (idx >= 0) return this.slotEligible(idx) ? slotBotId(idx) : null;
    return this.overflow.has(uniqueId) && this.overflowEligible ? "overflow" : null;
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
    if (bot === "overflow") return this.overflowEligible && this.overflow.size > 0;
    const i = Number(bot.slice(5));
    return this.slotEligible(i) && this.slots[i] != null;
  }

  private firstEligibleFree(): number {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i] === null && this.slotEligible(i)) return i;
    }
    return -1;
  }

  private assignEligible(uniqueId: string): Destination | null {
    const free = this.firstEligibleFree();
    if (free < 0) return null;
    this.slots[free] = uniqueId;
    return slotBotId(free);
  }

  private evictSlot(index: number): SlotChange[] {
    const uniqueId = this.slots[index];
    if (!uniqueId) return [];
    this.slots[index] = null;
    const placed = this.assignEligible(uniqueId);
    if (placed) return [{ uniqueId, from: slotBotId(index), to: placed }];
    this.markUnavailable(uniqueId);
    return [{ uniqueId, from: slotBotId(index), to: null }];
  }

  /** Free individual-slot capacity: unavailable occupants, then overflow, never a later arrival. */
  private fillFreeSlots(): SlotChange[] {
    const changes = this.placeUnavailable();
    for (;;) {
      const promoted = this.promoteOverflow();
      if (!promoted) break;
      changes.push(promoted);
    }
    return changes;
  }

  private placeUnavailable(): SlotChange[] {
    const changes: SlotChange[] = [];
    for (const uniqueId of [...this.unavailable]) {
      const placed = this.assignEligible(uniqueId);
      if (!placed) break;
      this.unavailable.delete(uniqueId);
      changes.push({ uniqueId, from: null, to: placed });
    }
    return changes;
  }

  /** Slots first, then overflow once that route is usable again. */
  private restoreUnavailable(): SlotChange[] {
    const changes = this.placeUnavailable();
    if (!this.overflowEligible) return changes;
    for (const uniqueId of [...this.unavailable]) {
      this.unavailable.delete(uniqueId);
      this.overflow.add(uniqueId);
      this.waiting.push(uniqueId);
      changes.push({ uniqueId, from: null, to: "overflow" });
    }
    return changes;
  }

  private promoteOverflow(): SlotChange | null {
    const next = this.waiting[0];
    if (!next) return null;
    const placed = this.assignEligible(next);
    if (!placed) return null;
    this.waiting.shift();
    this.overflow.delete(next);
    return { uniqueId: next, from: "overflow", to: placed };
  }

  private markUnavailable(uniqueId: string): void {
    this.unavailable.add(uniqueId);
  }
}
