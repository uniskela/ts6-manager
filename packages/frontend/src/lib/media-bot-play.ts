/** Last-used Media Bot Play action (localStorage). */

export type MediaPlayAction = 'playlist' | 'song' | 'video' | 'radio' | 'iptv';

export const MEDIA_PLAY_ACTIONS: readonly MediaPlayAction[] = [
  'playlist', 'song', 'video', 'radio', 'iptv',
] as const;

export const MEDIA_PLAY_LABELS: Record<MediaPlayAction, string> = {
  playlist: 'Playlist',
  song: 'Song',
  video: 'Video',
  radio: 'Radio',
  iptv: 'IPTV',
};

const STORAGE_PREFIX = 'ts6.mediaBot.lastPlay.';

export function isMediaPlayAction(value: unknown): value is MediaPlayAction {
  return typeof value === 'string' && (MEDIA_PLAY_ACTIONS as readonly string[]).includes(value);
}

export function getLastPlayAction(botId: number): MediaPlayAction {
  try {
    // typeof can throw SecurityError when storage access is denied by policy.
    if (typeof localStorage === 'undefined') return 'song';
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${botId}`);
    return isMediaPlayAction(raw) ? raw : 'song';
  } catch {
    return 'song';
  }
}

export function setLastPlayAction(botId: number, action: MediaPlayAction): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(`${STORAGE_PREFIX}${botId}`, action);
  } catch {
    /* quota / private mode / SecurityError */
  }
}
