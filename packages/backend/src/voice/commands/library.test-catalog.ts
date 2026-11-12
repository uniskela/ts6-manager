/** Shared in-memory PlaylistCatalog for library unit tests. */
export function fakePlaylistCatalog(playlists: Array<Record<string, unknown>>) {
  const songs: any[] = [];
  const links: any[] = [];
  let nextSong = 1;
  const db: any = {
    playlist: {
      findMany: async () => playlists.map((p) => ({ id: p.id, name: p.name })),
      findFirst: async ({ where }: any) => {
        const byId = playlists.find((p) => p.id === where.id);
        if (!byId) return null;
        return {
          ...byId,
          songs: links
            .filter((l) => l.playlistId === byId.id)
            .sort((a: any, b: any) => a.position - b.position)
            .map((l) => ({ position: l.position, song: songs.find((s) => s.id === l.songId) })),
        };
      },
    },
    song: {
      findFirst: async ({ where }: any) =>
        songs.find((s) => s.sourceUrl === where.sourceUrl && s.serverConfigId === where.serverConfigId) ?? null,
      create: async ({ data }: any) => {
        const created = { id: nextSong++, ...data };
        songs.push(created);
        return created;
      },
    },
    playlistSong: {
      findUnique: async ({ where }: any) => {
        const key = where.playlistId_songId;
        return links.find((l) => l.playlistId === key.playlistId && l.songId === key.songId) ?? null;
      },
      create: async ({ data }: any) => {
        links.push(data);
        return data;
      },
      deleteMany: async ({ where }: any) => {
        for (let i = links.length - 1; i >= 0; i -= 1) {
          if (links[i].playlistId === where.playlistId && links[i].songId === where.songId) {
            links.splice(i, 1);
          }
        }
        return { count: 1 };
      },
      aggregate: async ({ where }: any) => {
        const positions = links
          .filter((l) => !where?.playlistId || l.playlistId === where.playlistId)
          .map((l) => l.position);
        return { _max: { position: positions.length ? Math.max(...positions) : null } };
      },
    },
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(db),
    _songs: songs,
    _links: links,
  };
  return db;
}
