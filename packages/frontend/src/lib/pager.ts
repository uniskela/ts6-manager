/** Paging for long lists in the bot console (songs, playlists, stations, channels). */

export type PageSize = 25 | 50 | 100;
export const PAGE_SIZES: readonly PageSize[] = [25, 50, 100];
const DEFAULT_PAGE_SIZE: PageSize = 50;

export function pageSlice<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** "1–50 of 148 channels", or "0 songs" for an empty list. */
export function pageRangeLabel(total: number, page: number, pageSize: number, noun: string): string {
  if (total === 0) return `0 ${noun}`;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return `${first}–${last} of ${total} ${noun}`;
}

const storageKey = (listKey: string) => `ts6:page-size:${listKey}`;

/** The page size last chosen for this list, or 50. Storage may be blocked. */
export function rememberedPageSize(listKey: string, fallback: PageSize = DEFAULT_PAGE_SIZE): PageSize {
  try {
    const stored = Number(globalThis.localStorage?.getItem(storageKey(listKey)));
    return (PAGE_SIZES as readonly number[]).includes(stored) ? (stored as PageSize) : fallback;
  } catch {
    return fallback;
  }
}

export function rememberPageSize(listKey: string, size: PageSize): void {
  try {
    globalThis.localStorage?.setItem(storageKey(listKey), String(size));
  } catch {
    // Blocked storage: the choice just isn't remembered.
  }
}
