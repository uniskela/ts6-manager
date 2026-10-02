/**
 * Manual test for #259: can a bot identity show an avatar in the TeamSpeak 6 client?
 *
 * Connects a throwaway voice client, uploads an avatar the TeamSpeak 3 way
 * (file transfer to `/avatar`, then `clientupdate client_flag_avatar=<md5>`),
 * and stays connected so you can look at it in the TeamSpeak app. Ctrl+C leaves.
 *
 *   pnpm --filter @ts6/backend exec tsx scripts/bot-avatar-test.ts
 *
 * Environment:
 *   TS_HOST            server address (required)
 *   TS_PORT            voice port, default 9987
 *   TS_FT_PORT         file-transfer port if the server reply does not name one, default 30033
 *   TS_SERVER_PASSWORD server password, if any
 *   TS_CHANNEL         channel to join (name or path), default: the server's default channel
 *   TS_NICKNAME        default "Avatar test"
 *   TS_AVATAR          path to a PNG/JPEG/GIF (max 200 KB); default: a generated 128x128 PNG
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import zlib from 'node:zlib';
import { Ts3Client } from '../src/voice/tslib/client.js';
import { generateIdentity } from '../src/voice/tslib/identity.js';
import { buildCommand, type ParsedCommand } from '../src/voice/tslib/commands.js';

const MAX_AVATAR_BYTES = 200 * 1024;
const FT_TIMEOUT_MS = 15_000;

function generatedPng(size = 128): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  // Diagonal blue/orange stripes so the avatar is easy to spot.
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const blue = Math.floor((x + y) / 16) % 2 === 0;
      row.set(blue ? [0x2f, 0x6f, 0xe0] : [0xf0, 0xa5, 0x4a], 1 + x * 3);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function loadAvatar(): Buffer {
  const file = process.env.TS_AVATAR;
  if (!file) return generatedPng();
  const data = fs.readFileSync(file);
  if (data.length > MAX_AVATAR_BYTES) throw new Error(`TS_AVATAR is ${data.length} bytes; keep it under ${MAX_AVATAR_BYTES}`);
  return data;
}

const host = process.env.TS_HOST;
if (!host) {
  console.error('Set TS_HOST to your TeamSpeak server address.');
  process.exit(1);
}

const client = new Ts3Client();
const replies: ParsedCommand[] = [];
client.on('command', (cmd: ParsedCommand) => replies.push(cmd));

async function waitFor(match: (cmd: ParsedCommand) => boolean, ms = 10_000): Promise<ParsedCommand | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = replies.find(match);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

const isError = (code: string) => (cmd: ParsedCommand) => cmd.name === 'error' && cmd.params.return_code === code;

/**
 * Size of this client's stored avatar, or null if the server has none. The
 * server names it `avatar_` + the unique ID's bytes as letters a-p (one per nibble).
 */
async function storedAvatarSize(): Promise<number | null> {
  client.sendCommand(buildCommand('clientgetuidfromclid', { clid: String(client.getClientId()), return_code: 'avatar-uid' }));
  const uidReply = await waitFor((cmd) => cmd.name === 'notifyclientuidfromclid' || (isError('avatar-uid')(cmd) && cmd.params.id !== '0'));
  const uid = uidReply?.name === 'notifyclientuidfromclid' ? uidReply.params.cluid : null;
  if (!uid) throw new Error(`Could not read this client's unique ID: ${JSON.stringify(uidReply?.params ?? 'no reply')}`);

  const name = '/avatar_' + [...Buffer.from(uid, 'base64')]
    .map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15)))
    .join('');
  client.sendCommand(buildCommand('ftgetfileinfo', { cid: '0', cpw: '', name, return_code: 'avatar-info' }));
  const info = await waitFor((cmd) => cmd.name === 'notifyfileinfo' || (isError('avatar-info')(cmd) && cmd.params.id !== '0'));
  return info?.name === 'notifyfileinfo' ? Number(info.params.size) : null;
}

async function main(): Promise<void> {
  const avatar = loadAvatar();
  const md5 = crypto.createHash('md5').update(avatar).digest('hex');

  await client.connect({
    host: host!,
    port: Number(process.env.TS_PORT || 9987),
    identity: generateIdentity(8),
    nickname: process.env.TS_NICKNAME || 'Avatar test',
    serverPassword: process.env.TS_SERVER_PASSWORD,
    defaultChannel: process.env.TS_CHANNEL,
  });
  console.log(`Connected as client ${client.getClientId()}.`);

  client.sendCommand(buildCommand('ftinitupload', {
    clientftfid: '1', name: '/avatar', cid: '0', cpw: '',
    size: String(avatar.length), overwrite: '1', resume: '0', return_code: 'avatar-upload',
  }));
  const start = await waitFor((cmd) => cmd.name === 'notifystartupload'
    || (isError('avatar-upload')(cmd) && cmd.params.id !== '0'));
  if (!start || start.name !== 'notifystartupload') {
    throw new Error(`Upload refused: ${JSON.stringify(start?.params ?? 'no reply')}`);
  }

  const port = Number(start.params.port) || Number(process.env.TS_FT_PORT || 30033);
  const expectedBytes = Buffer.byteLength(start.params.ftkey) + avatar.length;
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, host!, () => {
      socket.write(start.params.ftkey);
      socket.end(avatar);
    });
    // Node sockets have no default timeout: give up if the transfer stalls.
    socket.setTimeout(FT_TIMEOUT_MS, () => socket.destroy(new Error(`File transfer stalled for ${FT_TIMEOUT_MS / 1000} s`)));
    socket.on('error', reject);
    socket.on('close', (hadError) => {
      if (hadError) return; // 'error' already rejected
      if (socket.bytesWritten < expectedBytes) {
        reject(new Error(`File transfer closed after ${socket.bytesWritten} of ${expectedBytes} bytes`));
      } else {
        resolve();
      }
    });
  });

  // A closed socket is not proof of success: ask the server for the stored file.
  const stored = await storedAvatarSize();
  if (stored !== avatar.length) {
    throw new Error(`Upload did not complete: the server has ${stored ?? 'no'} avatar bytes, expected ${avatar.length}`);
  }
  console.log(`Uploaded ${avatar.length} bytes over file-transfer port ${port} (server confirmed).`);

  client.sendCommand(buildCommand('clientupdate', { client_flag_avatar: md5, return_code: 'avatar-flag' }));
  const flag = await waitFor(isError('avatar-flag'));
  if (flag?.params.id !== '0') throw new Error(`Setting the avatar flag failed: ${JSON.stringify(flag?.params ?? 'no reply')}`);

  console.log(`Avatar set (md5 ${md5}).`);
  console.log('Now open the TeamSpeak app: does this bot show the avatar in the channel tree and in its client info?');
  console.log('Press Ctrl+C to disconnect.');
}

process.on('SIGINT', () => {
  client.disconnect();
  setTimeout(() => process.exit(0), 300);
});

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  client.disconnect();
  setTimeout(() => process.exit(1), 300);
});
