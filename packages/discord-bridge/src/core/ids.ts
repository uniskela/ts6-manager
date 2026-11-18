/** A bridge bot identity: one of N slot bots or the overflow bot. */
export type BotId = "overflow" | `slot-${number}`;

export function slotBotId(index: number): BotId {
  return `slot-${index}`;
}

export function isSlotBot(id: BotId): id is `slot-${number}` {
  return id.startsWith("slot-");
}

export function slotIndex(id: BotId): number | null {
  return isSlotBot(id) ? Number(id.slice("slot-".length)) : null;
}

/** Preferred receiver order from the Bridge-K contract: overflow first, then slot 0..N-1. */
export function preferredOrder(slotCount: number): BotId[] {
  return ["overflow", ...Array.from({ length: slotCount }, (_, i) => slotBotId(i))];
}
