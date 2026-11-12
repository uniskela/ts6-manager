/**
 * Playlist nameKey migration preview / preflight / finalisation (db-push companion).
 *
 * Usage (from packages/backend):
 *   node dist/voice/commands/playlist-namekey-finalize-cli.js --preview
 *   node dist/voice/commands/playlist-namekey-finalize-cli.js --preflight
 *   node dist/voice/commands/playlist-namekey-finalize-cli.js --confirm-finalize
 *
 * Development (tsx available):
 *   node --import tsx src/voice/commands/playlist-namekey-finalize-cli.ts --preview
 *
 * Container start uses the compiled dist entry via apply-schema.sh.
 * --preflight / --preview are read-only and safe on legacy DBs without nameKey.
 * Never renames, merges, or deletes playlists. Conflicts refuse finalisation.
 */
import { createRequire } from 'node:module';
import {
  finalizePlaylistNameKeyMigration,
  formatPlaylistNameKeyCompatibilityReport,
  preflightPlaylistNameKeyCompatibility,
  previewPlaylistNameKeyMigration,
} from './playlist-name.js';

const require = createRequire(import.meta.url);

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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const preview = argv.includes('--preview');
  const preflight = argv.includes('--preflight');
  const confirm = argv.includes('--confirm-finalize');
  const modeCount = [preview, preflight, confirm].filter(Boolean).length;
  if (modeCount !== 1) {
    console.error('Specify exactly one of --preview, --preflight, or --confirm-finalize');
    process.exit(2);
  }

  if (!process.env.DATABASE_URL?.trim()) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }

  const { prisma, disconnect } = await openPrisma();
  try {
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
