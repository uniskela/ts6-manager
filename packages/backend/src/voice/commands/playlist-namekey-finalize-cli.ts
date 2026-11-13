/**
 * Playlist nameKey migration preview / preflight / finalisation (db-push companion).
 *
 * Usage (from packages/backend):
 *   node dist/voice/commands/playlist-namekey-finalize-cli.js --preview
 *   node dist/voice/commands/playlist-namekey-finalize-cli.js --preflight
 *   node dist/voice/commands/playlist-namekey-finalize-cli.js --preflight --allow-absent
 *   node dist/voice/commands/playlist-namekey-finalize-cli.js --confirm-finalize
 *
 * Development (tsx available):
 *   node --import tsx src/voice/commands/playlist-namekey-finalize-cli.ts --preview
 *
 * Container start uses the compiled dist entry via apply-schema.sh with
 * `--preflight --allow-absent` so a genuine fresh install can proceed.
 * Manual operator checks must NOT pass `--allow-absent`: a missing target
 * exits non-zero and never reports compatible=true.
 *
 * Never renames, merges, or deletes playlists. Conflicts refuse finalisation.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  classifySqlitePreflightTarget,
  finalizePlaylistNameKeyMigration,
  formatPlaylistNameKeyCompatibilityReport,
  inspectTs6PlaylistSchema,
  preflightPlaylistNameKeyCompatibility,
  previewPlaylistNameKeyMigration,
} from './playlist-name.js';

const require = createRequire(import.meta.url);
const schemaDir = fileURLToPath(new URL('../../../prisma', import.meta.url));

async function openPrisma() {
  const { PrismaClient } = require('../../../generated/prisma/index.js') as typeof import('../../../generated/prisma/index.js');
  const prisma = new PrismaClient();
  return {
    prisma,
    disconnect: () => prisma.$disconnect(),
  };
}

function printAssessment(
  label: string,
  result: {
    playlistCount: number;
    wouldBackfill?: number;
    constraintsReady?: boolean;
    conflicts: { length: number };
    emptyNormalized: { length: number };
    compatible: boolean;
    report: string;
  },
): void {
  console.log(`[nameKey] ${label}`);
  console.log(`playlists=${result.playlistCount}`);
  if (result.wouldBackfill != null) console.log(`wouldBackfill=${result.wouldBackfill}`);
  if (result.constraintsReady != null) console.log(`constraintsReady=${result.constraintsReady}`);
  console.log(`conflicts=${result.conflicts.length}`);
  console.log(`emptyNormalized=${result.emptyNormalized.length}`);
  console.log(`compatible=${result.compatible}`);
  console.log(result.report);
}

function markerDbFile(): string | null {
  return (process.env.TS6_SCHEMA_DB_FILE || process.env.DB_FILE || '').trim() || null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const preview = argv.includes('--preview');
  const preflight = argv.includes('--preflight');
  const confirm = argv.includes('--confirm-finalize');
  const allowAbsent = argv.includes('--allow-absent');
  const modeCount = [preview, preflight, confirm].filter(Boolean).length;
  if (modeCount !== 1) {
    console.error('Specify exactly one of --preview, --preflight, or --confirm-finalize');
    process.exit(2);
  }
  if (allowAbsent && !preflight) {
    console.error('--allow-absent is only valid with --preflight (startup fresh-install path)');
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }

  const target = classifySqlitePreflightTarget({
    databaseUrl,
    schemaDir,
    markerDbFile: markerDbFile(),
  });
  if (target.kind === 'error') {
    console.error(`[nameKey] ${target.message}`);
    process.exit(1);
  }
  if (target.kind === 'absent_fresh') {
    if (confirm) {
      console.error(`[nameKey] refusing finalisation; database file is missing: ${target.absolutePath}`);
      process.exit(1);
    }
    // Manual operator checks must never report a false compatibility PASS.
    if (!allowAbsent) {
      console.error(`[nameKey] database not found: ${target.absolutePath}`);
      console.error('[nameKey] Target database was not checked (file does not exist).');
      console.error('[nameKey] Create/copy the database first, or for container fresh-install startup use --allow-absent.');
      process.exit(1);
    }
    console.log('[nameKey] preflight');
    console.log(`database=${target.absolutePath}`);
    console.log('playlists=0');
    console.log('conflicts=0');
    console.log('emptyNormalized=0');
    console.log('compatible=true');
    console.log(`Absent database at ${target.absolutePath} — treating as fresh install (no schema change yet).`);
    process.exit(0);
  }

  console.log(`[nameKey] database=${target.absolutePath}`);

  const { prisma, disconnect } = await openPrisma();
  try {
    // R4-1: existing files without a TS6 Playlist schema must not report compatible=true.
    // --allow-absent only covers a missing file, never an empty/unrelated existing DB.
    const schema = await inspectTs6PlaylistSchema(prisma as any);
    if (schema.kind !== 'ok') {
      console.error(`[nameKey] ${schema.message}`);
      process.exit(1);
    }

    if (preview) {
      const result = await previewPlaylistNameKeyMigration(prisma as any);
      printAssessment('preview', result);
      process.exit(result.compatible ? 0 : 1);
    }
    if (preflight) {
      const result = await preflightPlaylistNameKeyCompatibility(prisma as any);
      printAssessment('preflight', result);
      process.exit(result.compatible ? 0 : 1);
    }

    const before = await preflightPlaylistNameKeyCompatibility(prisma as any);
    if (!before.compatible) {
      console.error('[nameKey] refusing finalisation; resolve conflicts first:');
      console.error(formatPlaylistNameKeyCompatibilityReport(before.conflicts, before.emptyNormalized));
      process.exit(1);
    }
    const { backfilled } = await finalizePlaylistNameKeyMigration(prisma as any);
    const after = await previewPlaylistNameKeyMigration(prisma as any);
    console.log('[nameKey] finalised');
    console.log(`backfilled=${backfilled}`);
    console.log(`constraintsReady=${after.constraintsReady}`);
    console.log(`conflicts=${after.conflicts.length}`);
    console.log(`emptyNormalized=${after.emptyNormalized.length}`);
    console.log(`compatible=${after.compatible}`);
    if (!after.constraintsReady || !after.compatible) {
      console.error('[nameKey] finalisation incomplete');
      process.exit(1);
    }
  } finally {
    await disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
