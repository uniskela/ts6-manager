#!/usr/bin/env node
// Copies the repository's TS3 UDP client (packages/backend/src/voice/tslib) into .vendor/tslib so the
// isolated lab resolves its own node_modules (libsodium) without joining the pnpm workspace.
// The backend copy stays the source of truth: .vendor is generated, git-ignored, and `--check`
// fails when it has drifted. Test files are not copied.
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const candidates = [join(root, "../backend/src/voice/tslib"), join(root, "backend-src/voice/tslib")];
let src = null;
for (const c of candidates) {
  try { await readdir(c); src = c; break; } catch { /* try next */ }
}
if (!src) { console.error("tslib source not found"); process.exit(2); }
const dest = join(root, ".vendor/tslib");
const isSource = (f) => f.endsWith(".ts") && !f.endsWith(".test.ts");

async function digest(dir) {
  const h = createHash("sha256");
  for (const f of (await readdir(dir)).filter(isSource).sort()) {
    h.update(f); h.update(await readFile(join(dir, f)));
  }
  return h.digest("hex");
}

if (process.argv.includes("--check")) {
  const same = (await digest(src)) === (await digest(dest).catch(() => "missing"));
  console.log(same ? "tslib vendor copy matches source" : "tslib vendor copy DRIFTED; run sync:tslib");
  process.exit(same ? 0 : 1);
}
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
for (const f of (await readdir(src)).filter(isSource)) await cp(join(src, f), join(dest, f));
console.log(`synced tslib -> .vendor/tslib (${await digest(dest)})`);
