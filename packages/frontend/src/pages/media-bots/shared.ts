import axios from 'axios';
import type { YouTubeSearchResult } from '@ts6/common';


// ─── Helper ──────────────────────────────────────────────────────────────────

export function formatTime(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}


export interface UrlLoadInfo {
  type: 'video' | 'playlist';
  items: YouTubeSearchResult[];
  title?: string;
  sourceTrackCount?: number;
  matchedCount?: number;
  cappedAt?: number;
}


export function youtubeInfoErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err) && err.code === 'ECONNABORTED') {
    return 'Matching tracks is taking longer than expected — try again in a minute';
  }
  if (axios.isAxiosError(err) && err.response?.data?.error) {
    return String(err.response.data.error);
  }
  return 'Failed to load URL info';
}


export function urlInfoPlaylistLabel(info: UrlLoadInfo): string {
  if (info.type !== 'playlist') return 'Single Video';
  if (info.sourceTrackCount != null && info.matchedCount != null) {
    const cap = info.cappedAt ?? info.items.length;
    return `${info.matchedCount} matched of ${info.sourceTrackCount} (first ${cap} searched)`;
  }
  return `Playlist (${info.items.length} videos)`;
}


export function urlItemSelectKey(index: number): string {
  return String(index);
}


export function allUrlItemKeys(count: number): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i < count; i++) keys.add(urlItemSelectKey(i));
  return keys;
}


export function selectedUrlItems(items: YouTubeSearchResult[], selectedKeys: Set<string>): YouTubeSearchResult[] {
  return items.filter((_, i) => selectedKeys.has(urlItemSelectKey(i)));
}


export interface ImportJobStatus {
  phase?: 'matching' | 'importing';
  processed?: number;
  total?: number;
  matchProcessed?: number;
  matchTotal?: number;
  matched?: number;
  sourceTrackCount?: number;
  importCap?: number;
  enqueued?: number;
  musicBotId?: number;
  downloaded?: number;
  registered?: number;
  skipped?: number;
  errors?: string[];
}


export function importJobProgressLabel(job: ImportJobStatus | undefined | null): string {
  if (!job) return '?';
  if (job.phase === 'matching') {
    const ofSource =
      job.sourceTrackCount != null &&
      job.sourceTrackCount > (job.matchTotal ?? 0)
        ? ` of ${job.sourceTrackCount}`
        : '';
    return `Matching ${job.matchProcessed ?? 0}/${job.matchTotal ?? '?'}${ofSource} (${job.matched ?? 0} hits)`;
  }
  return `Importing ${job.processed ?? 0}/${job.total ?? '?'}`;
}


export function importJobCompleteMessage(job: ImportJobStatus): string {
  const parts: string[] = [];
  if ((job.registered ?? 0) > 0) parts.push(`${job.registered} registered`);
  if ((job.enqueued ?? 0) > 0) parts.push(`${job.enqueued} enqueued`);
  if ((job.downloaded ?? 0) > 0) parts.push(`${job.downloaded} downloaded`);
  if ((job.skipped ?? 0) > 0) parts.push(`${job.skipped} skipped`);
  const base = parts.length ? `Import complete: ${parts.join(', ')}` : 'Import complete';
  if (
    job.sourceTrackCount != null &&
    job.sourceTrackCount > (job.total ?? 0)
  ) {
    const cap = job.importCap ?? job.total ?? 0;
    return `${base}. Only first ${cap} of ${job.sourceTrackCount} source tracks — raise Max playlist import in Settings → Limits`;
  }
  return base;
}


export function importCapHint(maxPlaylistImport: number | undefined): string {
  const cap = maxPlaylistImport ?? 250;
  return `Imports up to ${cap} tracks (Settings → Limits). Large Apple Music playlists may need a higher cap (max 500).`;
}

