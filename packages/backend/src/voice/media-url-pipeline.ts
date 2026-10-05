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
  isSpotifyShareUrl,
} from './audio/youtube.js';
import { isYouTubePlaylistUrl } from './audio/playlist-import-plan.js';
import { resolveSpotifyCollection } from './audio/spotify.js';
import type { QueueItem } from './playlist/queue.js';

const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';
const PLAYLIST_CAP = 25;

export interface MediaUrlPipelineDeps {
  resolveSpotify(url: string): Promise<string>;
  resolveAppleMusic(url: string): Promise<AppleMusicResolved>;
  /** Tracks of a Spotify playlist/album, or null when the link is a single track. */
  resolveSpotifyCollection(url: string): Promise<{ title?: string; tracks: AppleMusicTrack[] } | null>;
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
  isCancelled?(): boolean;
}

/** Use the shared media resolvers and cache downloads as playable queue items. */
export function defaultMediaUrlDeps(): MediaUrlPipelineDeps {
  return {
    resolveSpotify: resolveSpotifyToYouTube,
    resolveAppleMusic: resolveAppleMusicTracks,
    resolveSpotifyCollection,
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

/** Normalize a rejected value for the background playlist error callback. */
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
  let urlsToPlay = [mediaUrl];
  let playlistTitle: string | undefined;
  let pendingTracks: AppleMusicTrack[] = [];
  let pendingSource = 'Apple Music';

  // Spotify / Apple Music playlists and albums: match each track on YouTube.
  let collection: { title?: string; tracks: AppleMusicTrack[] } | null = null;
  if (isSpotifyShareUrl(mediaUrl)) {
    collection = await deps.resolveSpotifyCollection(mediaUrl);
    if (collection) {
      pendingSource = 'Spotify';
    } else {
      mediaUrl = await deps.resolveSpotify(mediaUrl);
      urlsToPlay = [mediaUrl];
    }
  } else if (isAppleMusicShareUrl(mediaUrl)) {
    collection = await deps.resolveAppleMusic(mediaUrl);
  }

  if (collection) {
    if (!collection.tracks.length) {
      throw new Error(`Could not resolve any tracks from that ${pendingSource} URL`);
    }
    playlistTitle = collection.title;
    const firstYt = await deps.appleTrackToYouTube(collection.tracks[0]);
    if (!firstYt) {
      throw new Error(
        `No YouTube match for ${pendingSource} track: ${collection.tracks[0].artist} - ${collection.tracks[0].title}`,
      );
    }
    urlsToPlay = [firstYt];
    pendingTracks = collection.tracks.slice(1, cap);
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
  const queuedInBackground = rest.length + pendingTracks.length;
  if (queuedInBackground > 0) {
    void (async () => {
      const report = (error: unknown, label: string) => {
        opts.onBackgroundError?.(asError(error), label);
      };

      const queueUrl = async (url: string): Promise<boolean> => {
        if (target.isCancelled?.()) return false;
        const downloaded = await deps.downloadTrack(url);
        if (target.isCancelled?.()) return false;
        if (!req.enqueueOnly && target.isIdle()) {
          await target.play(downloaded, {});
        } else {
          target.enqueue(downloaded);
        }
        return true;
      };

      for (const url of rest) {
        if (target.isCancelled?.()) return;
        try {
          if (!await queueUrl(url)) return;
        } catch (error) {
          report(error, url);
        }
      }

      for (const track of pendingTracks) {
        if (target.isCancelled?.()) return;
        const label = `${track.artist} - ${track.title}`;
        try {
          const url = await deps.appleTrackToYouTube(track);
          if (!url) {
            report(new Error(`No YouTube match for ${pendingSource} track: ${label}`), label);
            continue;
          }
          if (!await queueUrl(url)) return;
        } catch (error) {
          report(error, label);
        }
      }
    })();
  }

  return { first, playlistTitle, queuedInBackground };
}
