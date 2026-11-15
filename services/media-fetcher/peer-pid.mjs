/** Map an accepted TCP socket to the connecting PID. Invert the 4-tuple. */
import fs from 'node:fs';

export function matchPeerInode(tableText, localPort, remotePort) {
  const hex = (n) => n.toString(16).toLowerCase().padStart(4, '0');
  const loc = hex(remotePort);
  const rem = hex(localPort);
  for (const line of tableText.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const lPort = cols[1].split(':')[1];
    const rPort = cols[2].split(':')[1];
    if (!lPort || !rPort) continue;
    if (lPort.toLowerCase() !== loc || rPort.toLowerCase() !== rem) continue;
    return cols[9];
  }
  return '';
}

export function pidOwningInode(inode) {
  if (!inode) return 0;
  for (const p of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    try {
      for (const fd of fs.readdirSync(`/proc/${p}/fd`)) {
        if (fs.readlinkSync(`/proc/${p}/fd/${fd}`) === `socket:[${inode}]`) return Number(p);
      }
    } catch { /* ESRCH */ }
  }
  return 0;
}

export function peerPidOnce(socket) {
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = fs.readFileSync(table, 'utf8'); } catch { continue; }
    const inode = matchPeerInode(text, socket.localPort, socket.remotePort);
    const pid = pidOwningInode(inode);
    if (pid) return pid;
  }
  return 0;
}

export function peerPid(socket, budgetMs = 80) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const pid = peerPidOnce(socket);
    if (pid) return pid;
  }
  return 0;
}
