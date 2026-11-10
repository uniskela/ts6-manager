/**
 * A join that was cancelled on purpose (the bot was told to leave, or it was destroyed, or the
 * runtime stopped). It is not a failure: it must not be retried, and it must not spend the rebuild
 * budget.
 */
export class JoinCancelled extends Error {
  readonly code = "JOIN_CANCELLED";
  constructor(reason = "join cancelled: the bot was told to leave or the bridge is stopping") {
    super(reason);
    this.name = "JoinCancelled";
  }
}

export const isJoinCancelled = (e: unknown): e is JoinCancelled =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "JOIN_CANCELLED";
