import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import { downloadYouTube, searchYouTube, getYouTubeUrlInfo, fetchYouTubeVideoMeta, parseYouTubeUrl } from '../voice/audio/youtube.js';
import { getImportJob, startYouTubePlaylistImport } from '../voice/audio/youtube-playlist-import.js';
import {
  appleMusicTrackToYouTubeUrl,
  isAppleMusicShareUrl,
  resolveAppleMusicTracks,
} from '../voice/audio/apple-music.js';
import {
  looksLikeYouTubeIdTitle,
  parseTitleArtistFromFilename,
  probeAudioTags,
  youtubeIdFromFilename,
} from '../voice/audio/metadata.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';

const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';
const ALLOWED_EXTENSIONS = ['.mp3', '.wav', '.flac', '.ogg', '.opus', '.m4a', '.aac', '.wma', '.webm'];
/** Cap Apple Music → YouTube matches for library info / import previews. */
const APPLE_MUSIC_INFO_CAP = 25;

async function resolveAppleMusicAsYouTubeInfo(url: string): Promise<{
  type: 'video' | 'playlist';
  items: Array<{ id: string; title: string; artist: string; duration: number; thumbnail: string }>;
  title?: string;
}> {
  const am = await resolveAppleMusicTracks(url);
  if (!am.tracks.length) {
    throw new AppError(502, 'Could not resolve any tracks from that Apple Music URL');
  }

  const items: Array<{ id: string; title: string; artist: string; duration: number; thumbnail: string }> = [];
  for (const track of am.tracks.slice(0, APPLE_MUSIC_INFO_CAP)) {
    try {
      const ytUrl = await appleMusicTrackToYouTubeUrl(track);
      if (!ytUrl) continue;
      const videoId = parseYouTubeUrl(ytUrl).videoId;
      if (!videoId) continue;
      items.push({
        id: videoId,
        title: track.title,
        artist: track.artist || 'Unknown',
        duration: 0,
        thumbnail: '',
      });
    } catch {
      /* skip failed YouTube matches */
    }
  }

  if (!items.length) {
    throw new AppError(502, 'No YouTube matches found for that Apple Music URL');
  }

  return {
    type: items.length > 1 ? 'playlist' : 'video',
    items,
    title: am.title,
  };
}

async function resolveMediaUrlForYouTubeDownload(url: string): Promise<string> {
  if (!isAppleMusicShareUrl(url)) return url;
  const am = await resolveAppleMusicTracks(url);
  if (!am.tracks.length) {
    throw new AppError(502, 'Could not resolve any tracks from that Apple Music URL');
  }
  if (am.tracks.length > 1) {
    throw new AppError(
      400,
      'Apple Music playlists cannot be downloaded as a single track — Load the URL first, then download selected songs or use !play / Play URL',
    );
  }
  const ytUrl = await appleMusicTrackToYouTubeUrl(am.tracks[0]);
  if (!ytUrl) {
    throw new AppError(
      502,
      `No YouTube match for Apple Music track: ${am.tracks[0].artist} - ${am.tracks[0].title}`,
    );
  }
  return ytUrl;
}
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

// Ensure music directory exists
if (!fs.existsSync(MUSIC_DIR)) {
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
}

async function enrichYouTubeIdFile(
  filePath: string,
  videoId: string,
): Promise<{
  title: string;
  artist: string | null;
  duration: number | null;
  source: string;
  sourceUrl: string;
}> {
  const tags = await probeAudioTags(filePath);
  let title = tags.title;
  let artist = tags.artist ?? null;
  let duration = tags.duration ?? null;

  if (!title || looksLikeYouTubeIdTitle(title)) {
    try {
      const meta = await fetchYouTubeVideoMeta(videoId);
      if (meta) {
        title = meta.title;
        artist = artist || meta.artist;
        if (duration == null && meta.duration) duration = meta.duration;
      }
    } catch {
      /* keep filename fallback */
    }
  }

  if (!title) title = videoId;
  if (duration == null) {
    try {
      duration = await getAudioDuration(filePath);
    } catch {
      /* ignore */
    }
  }

  return {
    title,
    artist,
    duration,
    source: 'youtube',
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MUSIC_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}`));
    }
  },
});

/** Bound expensive FS / yt-dlp operations (scan, import, batch download). */
const heavyMusicOpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many library scan/import requests, please try again later' },
});

/** Slightly higher budget for single downloads / uploads. */
const musicWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many library write requests, please try again later' },
});

export const musicLibraryRoutes: Router = Router({ mergeParams: true });

musicLibraryRoutes.use(requireRole('admin'));

// GET /songs — List songs for this server
musicLibraryRoutes.get('/songs', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const configId = parseInt(req.params.configId as string);
    const songs = await prisma.song.findMany({
      where: { serverConfigId: configId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(songs);
  } catch (err) { next(err); }
});

// POST /scan — Import audio files already present under MUSIC_DIR
musicLibraryRoutes.post('/scan', heavyMusicOpLimiter, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const configId = parseInt(req.params.configId as string);

    const existing = await prisma.song.findMany({
      where: { serverConfigId: configId },
    });
    const knownByPath = new Map<string, (typeof existing)[number]>(
      existing.map((s: (typeof existing)[number]) => [s.filePath, s]),
    );

    const entries = fs.readdirSync(MUSIC_DIR, { withFileTypes: true });
    let imported = 0;
    let updated = 0;
    const created: unknown[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext)) continue;
      const filePath = path.join(MUSIC_DIR, entry.name);
      const ytId = youtubeIdFromFilename(entry.name);
      const known = knownByPath.get(filePath);

      if (known) {
        // Repair rows that were scanned as local with a bare YouTube id title.
        const needsRepair =
          ytId &&
          (known.source === 'local' ||
            looksLikeYouTubeIdTitle(known.title) ||
            !known.sourceUrl);
        if (needsRepair && ytId) {
          const enriched = await enrichYouTubeIdFile(filePath, ytId);
          const confirmed = enriched.title !== ytId;
          if (
            confirmed &&
            (enriched.title !== known.title ||
              known.source !== 'youtube' ||
              !known.sourceUrl)
          ) {
            const song = await prisma.song.update({
              where: { id: known.id },
              data: {
                title: enriched.title,
                artist: enriched.artist ?? known.artist,
                duration: enriched.duration ?? known.duration,
                source: 'youtube',
                sourceUrl: enriched.sourceUrl,
              },
            });
            updated++;
            created.push(song);
          }
        }
        continue;
      }

      const stat = fs.statSync(filePath);
      let songData: {
        title: string;
        artist: string | null;
        duration: number | null;
        filePath: string;
        source: string;
        sourceUrl: string | null;
        fileSize: number;
        serverConfigId: number;
      };

      if (ytId) {
        const enriched = await enrichYouTubeIdFile(filePath, ytId);
        // Only mark as youtube when yt-dlp returned a real title (avoids false positives).
        const confirmed =
          enriched.title !== ytId && enriched.source === 'youtube' && !!enriched.sourceUrl;
        if (confirmed) {
          songData = {
            title: enriched.title,
            artist: enriched.artist,
            duration: enriched.duration,
            filePath,
            source: enriched.source,
            sourceUrl: enriched.sourceUrl,
            fileSize: stat.size,
            serverConfigId: configId,
          };
        } else {
          const fromName = parseTitleArtistFromFilename(entry.name);
          songData = {
            title: fromName.title,
            artist: fromName.artist,
            duration: enriched.duration,
            filePath,
            source: 'local',
            sourceUrl: null,
            fileSize: stat.size,
            serverConfigId: configId,
          };
        }
      } else {
        const tags = await probeAudioTags(filePath);
        const fromName = parseTitleArtistFromFilename(entry.name);
        const title = tags.title || fromName.title;
        const artist = tags.artist || fromName.artist;
        let duration = tags.duration ?? null;
        if (duration == null) {
          try {
            duration = await getAudioDuration(filePath);
          } catch {
            /* ignore */
          }
        }
        songData = {
          title,
          artist,
          duration,
          filePath,
          source: 'local',
          sourceUrl: null,
          fileSize: stat.size,
          serverConfigId: configId,
        };
      }

      const song = await prisma.song.create({ data: songData });
      created.push(song);
      imported++;
    }

    res.json({ imported, updated, songs: created });
  } catch (err) { next(err); }
});

// POST /upload — Upload audio file
musicLibraryRoutes.post('/upload', musicWriteLimiter, upload.single('file'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const configId = parseInt(req.params.configId as string);
    const file = req.file;
    if (!file) throw new AppError(400, 'No file uploaded');

    const tags = await probeAudioTags(file.path);
    const fromName = parseTitleArtistFromFilename(file.originalname);
    const title = tags.title || fromName.title;
    const artist = tags.artist || fromName.artist;
    let duration = tags.duration ?? null;
    if (duration == null) {
      try { duration = await getAudioDuration(file.path); } catch { /* ignore */ }
    }

    const song = await prisma.song.create({
      data: {
        title,
        artist,
        duration,
        filePath: file.path,
        source: 'local',
        fileSize: file.size,
        serverConfigId: configId,
      },
    });

    res.status(201).json(song);
  } catch (err) { next(err); }
});

// DELETE /songs/:id — Delete song
musicLibraryRoutes.delete('/songs/:id', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(req.params.id as string);
    const song = await prisma.song.findUnique({ where: { id } });
    if (!song) throw new AppError(404, 'Song not found');

    // Remove file from disk
    try {
      if (fs.existsSync(song.filePath)) {
        fs.unlinkSync(song.filePath);
      }
    } catch { /* ignore file deletion failure */ }

    await prisma.song.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /youtube/search — Search YouTube
musicLibraryRoutes.post('/youtube/search', async (req: Request, res: Response, next) => {
  try {
    const { query } = req.body;
    if (!query) throw new AppError(400, 'query is required');
    const results = await searchYouTube(query, 10);
    res.json(results);
  } catch (err) { next(err); }
});

// POST /youtube/download — Download from YouTube (Apple Music single tracks are resolved first)
musicLibraryRoutes.post('/youtube/download', musicWriteLimiter, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const configId = parseInt(req.params.configId as string);
    const { url } = req.body;
    if (!url) throw new AppError(400, 'url is required');

    const mediaUrl = await resolveMediaUrlForYouTubeDownload(url);
    const { filePath, info } = await downloadYouTube(mediaUrl, MUSIC_DIR);
    const fileStats = fs.statSync(filePath);

    // Check if song already exists for this server (by sourceUrl)
    const existing = await prisma.song.findFirst({
      where: { sourceUrl: mediaUrl, serverConfigId: configId },
    });
    if (existing) {
      return res.json(existing);
    }

    const song = await prisma.song.create({
      data: {
        title: info.title,
        artist: info.artist,
        duration: info.duration,
        filePath,
        source: 'youtube',
        sourceUrl: mediaUrl,
        fileSize: fileStats.size,
        serverConfigId: configId,
      },
    });

    res.status(201).json(song);
  } catch (err) { next(err); }
});

// POST /youtube/info — Get info about a YouTube / Apple Music URL (video or playlist)
musicLibraryRoutes.post('/youtube/info', async (req: Request, res: Response, next) => {
  try {
    const { url } = req.body;
    if (!url) throw new AppError(400, 'url is required');
    if (isAppleMusicShareUrl(url)) {
      const info = await resolveAppleMusicAsYouTubeInfo(url);
      return res.json(info);
    }
    const info = await getYouTubeUrlInfo(url);
    res.json(info);
  } catch (err) { next(err); }
});

// POST /youtube/import-playlist — Start background YouTube playlist import
musicLibraryRoutes.post('/youtube/import-playlist', heavyMusicOpLimiter, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const configId = parseInt(req.params.configId as string);
    const { url, playlistName, playlistId, reimport } = req.body;
    if (!url) throw new AppError(400, 'url is required');
    if (isAppleMusicShareUrl(url)) {
      throw new AppError(
        400,
        'Apple Music playlist import via this endpoint is not supported — Load the URL, then Download selected / use !play or Play URL',
      );
    }

    const jobId = await startYouTubePlaylistImport(prisma, configId, url, {
      playlistName,
      playlistId: playlistId != null ? parseInt(playlistId) : undefined,
      reimport: !!reimport,
    });
    res.status(202).json({ jobId });
  } catch (err) { next(err); }
});

// GET /youtube/import/:jobId — Poll import job status
musicLibraryRoutes.get('/youtube/import/:jobId', async (req: Request, res: Response, next) => {
  try {
    const job = getImportJob(req.params.jobId as string);
    if (!job) throw new AppError(404, 'Import job not found');
    res.json(job);
  } catch (err) { next(err); }
});

// POST /youtube/download-batch — Download multiple YouTube videos
musicLibraryRoutes.post('/youtube/download-batch', heavyMusicOpLimiter, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const configId = parseInt(req.params.configId as string);
    const { urls } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) throw new AppError(400, 'urls array is required');

    const results: any[] = [];
    const errors: string[] = [];

    for (const url of urls) {
      try {
        // Check if already downloaded
        const existing = await prisma.song.findFirst({
          where: { sourceUrl: url, serverConfigId: configId },
        });
        if (existing) {
          results.push(existing);
          continue;
        }

        const { filePath, info } = await downloadYouTube(url, MUSIC_DIR);
        const fileStats = fs.statSync(filePath);

        const song = await prisma.song.create({
          data: {
            title: info.title,
            artist: info.artist,
            duration: info.duration,
            filePath,
            source: 'youtube',
            sourceUrl: url,
            fileSize: fileStats.size,
            serverConfigId: configId,
          },
        });
        results.push(song);
      } catch (err: any) {
        errors.push(`${url}: ${err.message}`);
      }
    }

    res.json({ results, errors, total: urls.length, downloaded: results.length });
  } catch (err) { next(err); }
});

// Helper: get audio duration via ffprobe
function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath,
    ], { shell: false });

    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      try {
        const parsed = JSON.parse(output);
        resolve(parseFloat(parsed.format.duration) || 0);
      } catch {
        reject(new Error('Failed to parse ffprobe output'));
      }
    });
    proc.on('error', reject);
  });
}
