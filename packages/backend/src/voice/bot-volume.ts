/**
 * Persist a bot's shared volume. Writes for one bot run in request order so a
 * slower, older level cannot overwrite a newer one.
 */

/** Per-bot chain of volume writes. */
const volumeSaveTails = new Map<number, Promise<void>>();

/**
 * Save a bot volume after any earlier save for the same bot finishes. The
 * in-memory level is set in request order, but concurrent database writes can
 * complete in any order; queueing keeps the newest level as the last write.
 */
export function saveBotVolume(prisma: any, id: number, volume: number): Promise<void> {
  const prev = volumeSaveTails.get(id) ?? Promise.resolve();
  const next = prev
    .catch(() => { /* the earlier request reported its own failure */ })
    .then(() => prisma.musicBot.update({ where: { id }, data: { volume } }))
    .then(() => {});
  volumeSaveTails.set(id, next);
  const forget = () => { if (volumeSaveTails.get(id) === next) volumeSaveTails.delete(id); };
  next.then(forget, forget);
  return next;
}
