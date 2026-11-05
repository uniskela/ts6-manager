/**
 * Offline probe: load MusicBot #10 from discord-int-test.db and attempt a short TS voice connect.
 * Prints status only — no secrets.
 */
import { PrismaClient } from '../../generated/prisma/index.js';
import { decrypt } from '../utils/crypto.js';
import { restoreIdentity } from '../voice/tslib/index.js';
import { VoiceBot } from '../voice/voice-bot.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !databaseUrl.includes('discord-int-test.db')) {
    throw new Error('Refusing probe without discord-int-test.db DATABASE_URL');
  }
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const dbBot = await prisma.musicBot.findUnique({
    where: { id: 10 },
    include: { serverConfig: true },
  });
  if (!dbBot) throw new Error('MusicBot 10 not found');

  let identity;
  if (dbBot.identityData) {
    identity = restoreIdentity(JSON.parse(decrypt(dbBot.identityData)));
  }

  const bot = new VoiceBot({
    id: dbBot.id,
    serverConfigId: dbBot.serverConfigId,
    name: dbBot.name,
    serverHost: dbBot.serverConfig.host,
    serverPort: dbBot.voicePort ?? 9987,
    nickname: dbBot.nickname,
    serverPassword: dbBot.serverPassword ?? undefined,
    defaultChannel: dbBot.defaultChannel ?? undefined,
    volume: dbBot.volume,
    identity,
  });

  console.log(JSON.stringify({
    phase: 'pre-start',
    autoStart: dbBot.autoStart,
    host: dbBot.serverConfig.host,
    voicePort: dbBot.voicePort,
    status: bot.status,
  }));

  try {
    await bot.start();
    // Give the client a moment to finish handshake.
    await new Promise((r) => setTimeout(r, 4000));
    console.log(JSON.stringify({
      phase: 'post-start',
      status: bot.status,
      nickname: dbBot.nickname,
    }));
  } catch (err) {
    console.log(JSON.stringify({
      phase: 'start-error',
      status: bot.status,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    }));
  } finally {
    try {
      await Promise.resolve(bot.stop?.());
    } catch { /* ignore */ }
    try {
      await Promise.resolve((bot as { client?: { disconnect?: () => unknown } }).client?.disconnect?.());
    } catch { /* ignore */ }
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
