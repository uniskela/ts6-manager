/** TS6 avatar transfer sequence proven by scripts/bot-avatar-test.ts (#259, #261). */
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import type { Ts3Client } from './tslib/client.js';
import { buildCommand, type ParsedCommand } from './tslib/commands.js';

export const AVATAR_UPLOAD_REFUSED = "TeamSpeak refused the avatar upload. Allow file uploads for the bot's server group, or choose None.";
const TIMEOUT_MS = 15_000;

export function storedAvatarName(uid: string): string {
  return '/avatar_' + [...Buffer.from(uid, 'base64')].map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
}

function commandReply(client: Ts3Client, name: string, params: Record<string, string>, notification?: (cmd: ParsedCommand) => boolean, signal?: AbortSignal): Promise<ParsedCommand> {
  const code = `avatar-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const cleanup = () => { clearTimeout(timer); client.off('command', onCommand); client.off('disconnected', onDisconnect); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(abortError()); };
    const onDisconnect = () => { cleanup(); reject(new Error('Bot disconnected while applying avatar')); };
    const onCommand = (cmd: ParsedCommand) => {
      if (cmd.name === 'error' && cmd.params.return_code === code) {
        if (cmd.params.id !== '0') { cleanup(); reject(new Error(`TeamSpeak refused ${name} (error ${cmd.params.id})`)); }
        else if (!notification) { cleanup(); resolve(cmd); }
      } else if (notification?.(cmd)) { cleanup(); resolve(cmd); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Avatar ${name} timed out`)); }, TIMEOUT_MS);
    client.on('command', onCommand); client.on('disconnected', onDisconnect); signal?.addEventListener('abort', onAbort, { once: true });
    try { client.sendCommand(buildCommand(name, { ...params, return_code: code })); }
    catch (error) { cleanup(); reject(error); }
  });
}

export class AvatarAbortedError extends Error {
  constructor() { super('Avatar application was cancelled'); this.name = 'AvatarAbortedError'; }
}
function abortError(): AvatarAbortedError { return new AvatarAbortedError(); }

async function avatarName(client: Ts3Client, signal?: AbortSignal): Promise<string> {
  const clid = String(client.getClientId());
  const uid = await commandReply(client, 'clientgetuidfromclid', { clid }, (cmd) => cmd.name === 'notifyclientuidfromclid' && (!cmd.params.clid || cmd.params.clid === clid), signal);
  if (!uid.params.cluid) throw new Error('Could not read bot unique ID');
  return storedAvatarName(uid.params.cluid);
}

/** `signal` cancels pending commands and destroys the separate file-transfer socket (stop/restart). */
export async function applyBotAvatar(client: Ts3Client, host: string, image: Buffer | null, signal?: AbortSignal): Promise<void> {
  if (!image) {
    await commandReply(client, 'clientupdate', { client_flag_avatar: '' }, undefined, signal);
    // Deletion is untested on TS6. Clear the flag first and leave the old file
    // when the server refuses deletion; the bot remains connected.
    try { await commandReply(client, 'ftdeletefile', { cid: '0', cpw: '', name: await avatarName(client, signal) }, undefined, signal); }
    catch { /* a stale remote file is harmless once its flag is empty */ }
    return;
  }
  const clientftfid = String(Math.floor(Math.random() * 65534) + 1);
  let start: ParsedCommand;
  try {
    start = await commandReply(client, 'ftinitupload', { clientftfid, name: '/avatar', cid: '0', cpw: '', size: String(image.length), overwrite: '1', resume: '0' }, (cmd) => cmd.name === 'notifystartupload' && (!cmd.params.clientftfid || cmd.params.clientftfid === clientftfid), signal);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('TeamSpeak refused')) throw new Error(AVATAR_UPLOAD_REFUSED);
    throw error;
  }
  const port = Number(start.params.port) || 30033;
  const expectedBytes = Buffer.byteLength(start.params.ftkey) + image.length;
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const socket = net.connect(port, host, () => { socket.write(start.params.ftkey); socket.end(image); });
    const onAbort = () => socket.destroy(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('Avatar file transfer stalled')));
    socket.on('error', reject);
    socket.on('close', (hadError) => {
      signal?.removeEventListener('abort', onAbort);
      if (hadError) return;
      if (socket.bytesWritten < expectedBytes) reject(new Error('Avatar file transfer closed before all bytes were written'));
      else resolve();
    });
  });
  const name = await avatarName(client, signal);
  const info = await commandReply(client, 'ftgetfileinfo', { cid: '0', cpw: '', name }, (cmd) => cmd.name === 'notifyfileinfo' && (!cmd.params.name || cmd.params.name === name), signal);
  if (Number(info.params.size) !== image.length) throw new Error(`Upload did not complete: the server has ${info.params.size ?? 'no'} avatar bytes, expected ${image.length}`);
  await commandReply(client, 'clientupdate', { client_flag_avatar: createHash('md5').update(image).digest('hex') }, undefined, signal);
}
