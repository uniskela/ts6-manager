import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../middleware/error-handler.js';
import { botAvatarDataDir } from './bot-avatar-storage.js';

export const MAX_BANNER_BYTES = 5 * 1024 * 1024;
export const MAX_BANNERS = 100;
export const BANNER_DIR = 'channel-banners';

export type BannerExtension = 'png' | 'jpg' | 'gif' | 'webp';
const BANNER_MIME: Record<BannerExtension, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** Server-generated names only: `<32 hex>.<ext>`. Anything else is never read or removed. */
const BANNER_NAME = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;

export interface StoredBanner {
  name: string;
  size: number;
  createdAt: string;
}

export const channelBannerDataDir = botAvatarDataDir;

export function bannerImageType(image: Buffer): { extension: BannerExtension; mime: string } {
  if (image.length > MAX_BANNER_BYTES) throw new AppError(400, 'Banner must be at most 5 MB');
  let extension: BannerExtension | null = null;
  if (image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) extension = 'png';
  else if (image[0] === 255 && image[1] === 216 && image[2] === 255) extension = 'jpg';
  else if (['GIF87a', 'GIF89a'].includes(image.subarray(0, 6).toString('ascii'))) extension = 'gif';
  else if (image.subarray(0, 4).toString('ascii') === 'RIFF' && image.subarray(8, 12).toString('ascii') === 'WEBP') extension = 'webp';
  if (!extension) throw new AppError(400, 'Banner must be a PNG, JPEG, GIF or WebP image');
  return { extension, mime: BANNER_MIME[extension] };
}

export function isBannerName(name: unknown): name is string {
  return typeof name === 'string' && BANNER_NAME.test(name);
}

export function bannerMime(name: string): string {
  return BANNER_MIME[name.slice(name.lastIndexOf('.') + 1) as BannerExtension];
}

export async function listChannelBanners(dataDir = channelBannerDataDir()): Promise<StoredBanner[]> {
  let names: string[];
  try {
    names = (await readdir(path.join(dataDir, BANNER_DIR))).filter(isBannerName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const banners = await Promise.all(names.map(async (name) => {
    try {
      const info = await stat(path.join(dataDir, BANNER_DIR, name));
      return { name, size: info.size, createdAt: info.mtime.toISOString() };
    } catch { return null; }
  }));
  return banners.filter((b): b is StoredBanner => !!b).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name));
}

/** Store an uploaded banner under a fresh random name; the original filename is never used. */
export async function saveChannelBanner(image: Buffer, dataDir = channelBannerDataDir()): Promise<StoredBanner> {
  const { extension } = bannerImageType(image);
  if ((await listChannelBanners(dataDir)).length >= MAX_BANNERS) {
    throw new AppError(400, `At most ${MAX_BANNERS} banners can be hosted; delete one first`);
  }
  const name = `${randomUUID().replace(/-/g, '')}.${extension}`;
  await mkdir(path.join(dataDir, BANNER_DIR), { recursive: true });
  const destination = path.join(dataDir, BANNER_DIR, name);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, image, { flag: 'wx', mode: 0o644 });
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(() => {}); }
  const info = await stat(destination);
  return { name, size: info.size, createdAt: info.mtime.toISOString() };
}

export async function readChannelBanner(name: string, dataDir = channelBannerDataDir()): Promise<Buffer | null> {
  if (!isBannerName(name)) return null;
  try {
    return await readFile(path.join(dataDir, BANNER_DIR, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function hasChannelBanner(name: string, dataDir = channelBannerDataDir()): Promise<boolean> {
  if (!isBannerName(name)) return false;
  try {
    return (await stat(path.join(dataDir, BANNER_DIR, name))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Returns false when the banner does not exist (or is not a name this module generated). */
export async function deleteChannelBanner(name: string, dataDir = channelBannerDataDir()): Promise<boolean> {
  if (!isBannerName(name)) return false;
  try {
    await unlink(path.join(dataDir, BANNER_DIR, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
