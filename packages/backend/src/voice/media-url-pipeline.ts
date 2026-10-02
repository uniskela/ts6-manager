import {
  appleMusicTrackToYouTubeUrl,
  isAppleMusicShareUrl,
  resolveAppleMusicTracks,
  type AppleMusicResolved,
  type AppleMusicTrack,
} from './audio/apple-music.js';
import {
  downloadYouTube,
  expandYouTubeToWatchUrls,
  isYouTubeHostUrl,
  parseYouTubeUrl,
  resolveSpotifyToYouTube,
} from './audio/youtube.js';
import { isYouTubePlaylistUrl } from './audio/playlist-import-plan.js';
import type { QueueItem } from './playlist/queue.js';

const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';
const PLAYLIST_CAP = 25;

export interface MediaUrlPipelineDeps {
  resolveSpotify(url: string): Promise<string>;
  resolveAppleMusic(url: string): Promise<AppleMusicResolved>;
  appleTrackToYouTube(track: AppleMusicTrack): Promise<string | null>;
  expandYouTube(url: string, cap: number): Promise<{ title?: string; urls: string[] } | null>;
  downloadTrack(url: string): Promise<QueueItem>;
}

export interface MediaUrlRequest {
  url: string;
  enqueueOnly: boolean;
  cap?: number;
}

export interface MediaUrlTarget {
  play(item: QueueItem, opts: { replaceSessionIds?: string[] }): Promise<void>;
  enqueue(item: QueueItem): void;
  isIdle(): boolean;
}

export function defaultMediaUrlDeps(): MediaUrlPipelineDeps {
  return {
    resolveSpotify: resolveSpotifyToYouTube,
    resolveAppleMusic: resolveAppleMusicTracks,
    appleTrackToYouTube: appleMusicTrackToYouTubeUrl,
    expandYouTube: async (url, cap) => {
      const expanded = await expandYouTubeToWatchUrls(url, cap);
      return expanded ? { title: expanded.title, urls: expanded.urls } : null;
    },
    downloadTrack: async (url) => {
      const { filePath, info } = await downloadYouTube(url, MUSIC_DIR);
      return {
        id: `yt_${info.id}`,
        title: info.title,
        artist: info.artist,
        duration: info.duration,
        filePath,
        source: 'youtube' as const,
        sourceUrl: url,
      };
    },
  };
}

function isSpotifyShareUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'open.spotify.com' ||
      host === 'spotify.com' ||
      host.endsWith('.spotify.com') ||
      host === 'spotify.link'
    );
  } catch {
    return false;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Resolve a URL, start or enqueue its first track, and expand the remainder
 * without holding the request open for every playlist download.
 */
export async function runMediaUrlPipeline(
  deps: MediaUrlPipelineDeps,
  target: MediaUrlTarget,
  req: MediaUrlRequest,
  opts: {
    replaceSessionIds?: string[];
    onBackgroundError?: (err: Error, label: string) => void;
  } = {},
): Promise<{ first: QueueItem; playlistTitle?: string; queuedInBackground: number }> {
  const cap = req.cap ?? PLAYLIST_CAP;
  let mediaUrl = req.url;
  if (isSpotifyShareUrl(mediaUrl)) {
    mediaUrl = await deps.resolveSpotify(mediaUrl);
  }

  let urlsToPlay = [mediaUrl];
  let playlistTitle: string | undefined;
  let appleMusicPending: AppleMusicTrack[] = [];

  if (isAppleMusicShareUrl(mediaUrl)) {
    const resolved = await deps.resolveAppleMusic(mediaUrl);
    if (!resolved.tracks.length) {
      throw new Error('Could not resolve any tracks from that Apple Music URL');
    }
    playlistTitle = resolved.title;
    const firstYt = await deps.appleTrackToYouTube(resolved.tracks[0]);
    if (!firstYt) {
      throw new Error(
        `No YouTube match for Apple Music track: ${resolved.tracks[0].artist} - ${resolved.tracks[0].title}`,
      );
    }
    urlsToPlay = [firstYt];
    appleMusicPending = resolved.tracks.slice(1, cap);
  } else if (isYouTubeHostUrl(mediaUrl)) {
    const parsed = parseYouTubeUrl(mediaUrl);
    if (isYouTubePlaylistUrl(mediaUrl)) {
      let expanded: { title?: string; urls: string[] } | null;
      try {
        expanded = await deps.expandYouTube(mediaUrl, cap);
      } catch {
        throw new Error('Could not resolve any videos from that playlist URL');
      }
      if (expanded?.urls.length) {
        urlsToPlay = expanded.urls.slice(0, cap);
        playlistTitle = expanded.title;
      } else {
        throw new Error('Could not resolve any videos from that playlist URL');
      }
    } else if (parsed.watchUrl) {
      urlsToPlay = [parsed.watchUrl];
    } else if (parsed.canonicalUrl && parsed.videoId) {
      urlsToPlay = [`https://www.youtube.com/watch?v=${parsed.videoId}`];
    } else {
      throw new Error('Could not resolve that YouTube URL');
    }
  }

  const first = await deps.downloadTrack(urlsToPlay[0]);
  if (req.enqueueOnly) {
    target.enqueue(first);
  } else {
    await target.play(first, { replaceSessionIds: opts.replaceSessionIds });
  }

  const rest = urlsToPlay.slice(1);
  const queuedInBackground = rest.length + appleMusicPending.length;
  if (queuedInBackground > 0) {
    void (async () => {
      const report = (error: unknown, label: string) => {
        opts.onBackgroundError?.(asError(error), label);
      };

      const queueUrl = async (url: string): Promise<void> => {
        const downloaded = await deps.downloadTrack(url);
        if (!req.enqueueOnly && target.isIdle()) {
          await target.play(downloaded, {});
        } else {
          target.enqueue(downloaded);
        }
      };

      for (const url of rest) {
        try {
          await queueUrl(url);
        } catch (error) {
          report(error, url);
        }
      }

      for (const track of appleMusicPending) {
        const label = `${track.artist} - ${track.title}`;
        try {
          const url = await deps.appleTrackToYouTube(track);
          if (!url) {
            report(new Error(`No YouTube match for Apple Music track: ${label}`), label);
            continue;
          }
          await queueUrl(url);
        } catch (error) {
          report(error, label);
        }
      }
    })();
  }

  return { first, playlistTitle, queuedInBackground };
}
