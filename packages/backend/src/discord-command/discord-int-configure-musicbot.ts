/**
 * One-shot operator helper: configure MusicBot #10 for the disposable discord-int TS lab.
 * Does not print secrets. Run from packages/backend with DATABASE_URL + ENCRYPTION_KEY set.
 */
import { PrismaClient } from '../../generated/prisma/index.js';
import { encrypt } from '../utils/crypto.js';
import { generateIdentity } from '../voice/tslib/identity.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !databaseUrl.includes('discord-int-test.db')) {
    throw new Error('Refusing to run without DATABASE_URL pointing at discord-int-test.db');
  }
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY required to store music-bot identity');
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const apiKey = process.env.DISCORD_INT_TS_API_KEY || 'discord-int-lab-webquery-api-key-not-for-prod';
  const sshPassword = process.env.DISCORD_INT_TS_ADMIN_PASSWORD || 'discord-int-lab-query-admin';

  await prisma.tsServerConfig.update({
    where: { id: 1 },
    data: {
      name: 'Discord Int Disposable TS',
      host: '127.0.0.1',
      webqueryPort: 11080,
      apiKey,
      useHttps: false,
      sshPort: 11022,
      sshUsername: 'serveradmin',
      sshPassword,
      enabled: true,
      isDemo: false,
    },
  });

  const identity = generateIdentity(8);
  const identityData = encrypt(JSON.stringify(identity, (_k, v) =>
    (typeof v === 'bigint' ? v.toString() : v)));

  await prisma.musicBot.update({
    where: { id: 10 },
    data: {
      name: 'Discord Int Lab Bot',
      nickname: 'DiscordIntLab',
      serverConfigId: 1,
      voicePort: 19987,
      volume: 40,
      autoStart: true,
      identityData,
      defaultChannel: null,
      serverPassword: null,
    },
  });

  const bot = await prisma.musicBot.findUnique({
    where: { id: 10 },
    include: { serverConfig: true },
  });
  if (!bot) throw new Error('MusicBot 10 missing after update');

  console.log(JSON.stringify({
    ok: true,
    botId: bot.id,
    autoStart: bot.autoStart,
    voicePort: bot.voicePort,
    host: bot.serverConfig.host,
    webqueryPort: bot.serverConfig.webqueryPort,
    sshPort: bot.serverConfig.sshPort,
    hasIdentity: Boolean(bot.identityData),
  }));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
