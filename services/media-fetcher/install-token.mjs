/** Copy host token into the jobs volume as uid 1000 mode 600. Runs as container root. */
import fs from 'node:fs';
import { assertPrivateTokenMode } from './token.mjs';

const src = process.env.TOKEN_SRC || '/src/token';
const dest = process.env.TOKEN_DEST || '/jobs/.token';
const uid = Number(process.env.TOKEN_UID || 1000);
const gid = Number(process.env.TOKEN_GID || 1000);

const st = fs.statSync(src);
assertPrivateTokenMode(st.mode);
const token = fs.readFileSync(src);
if (token.toString().replace(/\s+/g, '').length < 16) throw new Error('fetcher token too short');
fs.writeFileSync(dest, token, { mode: 0o600 });
try {
  fs.chownSync(dest, uid, gid);
} catch (err) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) throw err;
}
fs.chmodSync(dest, 0o600);
