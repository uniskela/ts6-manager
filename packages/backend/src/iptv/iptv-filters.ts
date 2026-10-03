import { Prisma, type PrismaClient, type IptvChannel } from '../../generated/prisma/index.js';

// Match JavaScript trim() in the available-values endpoint and saved-pick UI.
const CODE_WHITESPACE = ' \t\r\n\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

/** Providers and query parameters may list several codes in either format. */
export function splitIptvCodes(value?: string | null): string[] {
  return [...new Set((value ?? '').split(/[;,]/).map((code) => code.trim().toLowerCase()).filter(Boolean))];
}

export interface IptvChannelFilters {
  serverConfigId: number;
  playlistId?: number;
  countries: string[];
  languages: string[];
  group?: string;
  search?: string;
  channelKey?: string;
  channelId?: number;
}

/** SQLite lacks array fields: split metadata into exact tokens inside the query.
 * Keep filtering in SQL so totals and paging do not load whole playlists or
 * expand matching channel IDs beyond SQLite's parameter limit.
 */
function codeMatches(column: Prisma.Sql, codes: string[]): Prisma.Sql {
  return Prisma.sql`EXISTS (
    WITH RECURSIVE codes(value, rest) AS (
      SELECT '', replace(coalesce(${column}, ''), ';', ',') || ','
      UNION ALL
      SELECT substr(rest, 1, instr(rest, ',') - 1), substr(rest, instr(rest, ',') + 1)
      FROM codes WHERE rest <> ''
    )
    SELECT 1 FROM codes WHERE lower(trim(value, ${CODE_WHITESPACE})) IN (${Prisma.join(codes)})
  )`;
}

function scopedChannels(filters: IptvChannelFilters): Prisma.Sql {
  const conditions = [Prisma.sql`p."serverConfigId" = ${filters.serverConfigId}`];
  if (filters.playlistId !== undefined) conditions.push(Prisma.sql`c."playlistId" = ${filters.playlistId}`);
  if (filters.countries.length) conditions.push(codeMatches(Prisma.sql`c."tvgCountry"`, filters.countries));
  if (filters.languages.length) conditions.push(codeMatches(Prisma.sql`c."tvgLanguage"`, filters.languages));
  if (filters.group) conditions.push(Prisma.sql`c."groupTitle" = ${filters.group}`);
  if (filters.search) conditions.push(Prisma.sql`instr(lower(c."name"), lower(${filters.search})) > 0`);
  if (filters.channelKey) conditions.push(Prisma.sql`(c."tvgId" = ${filters.channelKey} OR c."name" = ${filters.channelKey})`);
  if (filters.channelId !== undefined) conditions.push(Prisma.sql`c."id" = ${filters.channelId}`);
  return Prisma.sql`FROM "IptvChannel" c JOIN "IptvPlaylist" p ON p."id" = c."playlistId"
    WHERE ${Prisma.join(conditions, ' AND ')}`;
}

export async function filteredIptvGroups(prisma: PrismaClient, filters: IptvChannelFilters) {
  const rows = await prisma.$queryRaw<Array<{ groupTitle: string | null; count: bigint }>>(Prisma.sql`
    SELECT c."groupTitle", COUNT(*) AS count ${scopedChannels(filters)} GROUP BY c."groupTitle"
  `);
  return rows.map((row) => ({ groupTitle: row.groupTitle, _count: { _all: Number(row.count) } }));
}

export async function filteredIptvChannels(prisma: PrismaClient, filters: IptvChannelFilters, page: number, pageSize: number) {
  const scope = scopedChannels(filters);
  const [count, channels] = await Promise.all([
    prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`SELECT COUNT(*) AS total ${scope}`),
    prisma.$queryRaw<Array<IptvChannel & { playlistName: string }>>(Prisma.sql`
      SELECT c.*, p."name" AS "playlistName" ${scope}
      ORDER BY c."playlistId" ASC, c."position" ASC, c."id" ASC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `),
  ]);
  return {
    total: Number(count[0].total),
    rows: channels.map((channel) => ({ ...channel, playlist: { name: channel.playlistName } })),
  };
}
