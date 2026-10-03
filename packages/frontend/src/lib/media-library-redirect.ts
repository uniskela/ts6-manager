/**
 * Old Media Bots links (1.9.x and earlier) and where they live in 1.10.0.
 * Bots, Queue and Video moved to the Bot Hub and each bot's console;
 * Commands moved to Bot Flows. Every other tab stays on `/media-bots`.
 */

/** Media Library tabs addressable as `/media-bots?tab=…`. */
export const MEDIA_LIBRARY_TABS = ['library', 'playlists', 'radio', 'requests', 'streaming'] as const;

export type MediaLibraryTab = (typeof MEDIA_LIBRARY_TABS)[number];

export function isMediaLibraryTab(value: string | null): value is MediaLibraryTab {
  return value !== null && (MEDIA_LIBRARY_TABS as readonly string[]).includes(value);
}

function botIdParam(params: URLSearchParams): number | null {
  const raw = params.get('bot');
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Where an old `/media-bots` link should go now, or null when it already
 * points at a Media Library tab (or at no tab, which opens Library).
 */
export function mediaLibraryRedirect(params: URLSearchParams): string | null {
  const tab = params.get('tab');
  const botId = botIdParam(params);
  switch (tab) {
    case 'bots':
      return '/bot-hub';
    case 'queue':
      return botId ? `/bot-hub/${botId}` : '/bot-hub';
    case 'video':
      return botId ? `/bot-hub/${botId}` : '/media-bots?tab=streaming';
    case 'commands':
      return '/bots?tab=commands';
    default:
      return null;
  }
}
