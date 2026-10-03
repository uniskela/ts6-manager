import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../middleware/error-handler.js';

export type BotAvatarMode = 'none' | 'default' | 'custom';
export const MAX_AVATAR_BYTES = 200 * 1024;
export const DEFAULT_AVATAR_FILE = fileURLToPath(new URL('../../assets/default-bot-avatar.png', import.meta.url));
export const botAvatarDataDir = () => process.env.DATA_DIR || fileURLToPath(new URL('../../data/', import.meta.url));

export function avatarImageType(image: Buffer): { extension: 'png' | 'jpg' | 'gif'; mime: string } {
  if (image.length > MAX_AVATAR_BYTES) throw new AppError(400, 'Avatar must be at most 200 KB');
  if (image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: 'png', mime: 'image/png' };
  if (image[0] === 255 && image[1] === 216 && image[2] === 255) return { extension: 'jpg', mime: 'image/jpeg' };
  if (['GIF87a', 'GIF89a'].includes(image.subarray(0, 6).toString('ascii'))) return { extension: 'gif', mime: 'image/gif' };
  throw new AppError(400, 'Avatar must be a PNG, JPEG or GIF image');
}

export async function saveBotAvatar(botId: number, image: Buffer, dataDir = botAvatarDataDir()): Promise<{ avatarFile: string; avatarMd5: string }> {
  if (!Number.isSafeInteger(botId) || botId <= 0) throw new AppError(400, 'Invalid bot ID');
  const { extension } = avatarImageType(image);
  const avatarFile = `bot-avatars/${botId}.${extension}`;
  await mkdir(path.join(dataDir, 'bot-avatars'), { recursive: true });
  const destination = path.join(dataDir, avatarFile);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, image, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(() => {}); }
  return { avatarFile, avatarMd5: createHash('md5').update(image).digest('hex') };
}

export async function readBotAvatar(bot: { id: number; avatarMode?: string; avatarFile?: string | null }, dataDir = botAvatarDataDir()): Promise<Buffer | null> {
  if (!bot.avatarMode || bot.avatarMode === 'none') return null;
  if (bot.avatarMode === 'default') return readFile(DEFAULT_AVATAR_FILE);
  if (!bot.avatarFile || !new RegExp(`^bot-avatars/${bot.id}\\.(png|jpg|gif)$`).test(bot.avatarFile)) throw new AppError(400, 'Invalid avatar file');
  return readFile(path.join(dataDir, bot.avatarFile));
}
