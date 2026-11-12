/**
 * Playlist nameKey migration preview / finalisation (db-push companion).
 *
 * Usage (from packages/backend):
 *   node --import tsx src/voice/commands/playlist-namekey-finalize-cli.ts --preview
 *   node --import tsx src/voice/commands/playlist-namekey-finalize-cli.ts --confirm-finalize
 *
 * Container start uses the compiled dist entry via apply-schema.sh.
 * Never renames, merges, or deletes playlists. Conflicts refuse finalisation.
 */
import { createRequire } from 'node:module';
import {
  finalizePlaylistNameKeyMigration,
  formatPlaylistNameConflictReport,
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const preview = argv.includes('--preview');
  const confirm = argv.includes('--confirm-finalize');
  if (preview === confirm) {
    console.error('Specify exactly one of --preview or --confirm-finalize');
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
      console.log('[nameKey] preview');
      console.log(`playlists=${result.playlistCount}`);
      console.log(`wouldBackfill=${result.wouldBackfill}`);
      console.log(`constraintsReady=${result.constraintsReady}`);
      console.log(`conflicts=${result.conflicts.length}`);
      console.log(result.report);
      process.exit(result.conflicts.length ? 1 : 0);
    }

    const before = await previewPlaylistNameKeyMigration(prisma as any);
    if (before.conflicts.length) {
      console.error('[nameKey] refusing finalisation; resolve conflicts first:');
      console.error(formatPlaylistNameConflictReport(before.conflicts));
      process.exit(1);
    }
    const { backfilled } = await finalizePlaylistNameKeyMigration(prisma as any);
    const after = await previewPlaylistNameKeyMigration(prisma as any);
    console.log('[nameKey] finalised');
    console.log(`backfilled=${backfilled}`);
    console.log(`constraintsReady=${after.constraintsReady}`);
    console.log(`conflicts=${after.conflicts.length}`);
    if (!after.constraintsReady || after.conflicts.length) {
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
