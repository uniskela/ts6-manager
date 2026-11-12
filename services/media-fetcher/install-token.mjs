/** Install radio Job API token and optional ctl secret as uid 1000 mode 600.
 * Runs as container root. Compose grants only CAP_DAC_OVERRIDE + CAP_CHOWN.
 * chmod before chown so FOWNER is not required. */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { assertPrivateTokenMode } from './token.mjs';

const src = process.env.TOKEN_SRC || '/src/token';
const dest = process.env.TOKEN_DEST || '/jobs/.token';
const ctlSrc = process.env.CTL_TOKEN_SRC || '';
const ctlDest = process.env.CTL_TOKEN_DEST || '';
const uid = Number(process.env.TOKEN_UID || 1000);
const gid = Number(process.env.TOKEN_GID || 1000);

function installSecret(bytes, path) {
  // Unlink first so rotation recreates as root. chmod of a uid-1000 file needs
  // FOWNER; create+chmod+chown only needs DAC_OVERRIDE + CHOWN.
  try { fs.unlinkSync(path); } catch { /* first install */ }
  fs.writeFileSync(path, bytes, { mode: 0o600 });
  fs.chmodSync(path, 0o600);
  try {
    fs.chownSync(path, uid, gid);
  } catch (err) {
    if (typeof process.getuid === 'function' && process.getuid() === 0) throw err;
  }
  const st = fs.statSync(path);
  if ((st.mode & 0o777) !== 0o600) throw new Error(`bad mode on ${path}`);
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    if (st.uid !== uid || st.gid !== gid) throw new Error(`bad owner on ${path}`);
  }
}

const st = fs.statSync(src);
assertPrivateTokenMode(st.mode);
const token = fs.readFileSync(src);
if (token.toString().replace(/\s+/g, '').length < 16) throw new Error('fetcher token too short');
installSecret(token, dest);

if (ctlDest) {
  let ctl;
  if (ctlSrc) {
    const cst = fs.statSync(ctlSrc);
    assertPrivateTokenMode(cst.mode);
    ctl = fs.readFileSync(ctlSrc);
  } else {
    ctl = Buffer.from(`${randomBytes(32).toString('hex')}\n`);
  }
  if (ctl.toString().replace(/\s+/g, '').length < 16) throw new Error('ctl token too short');
  installSecret(ctl, ctlDest);
}
