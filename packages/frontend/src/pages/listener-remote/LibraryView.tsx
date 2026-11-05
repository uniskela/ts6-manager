import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  enqueueRemoteMutation,
  formatTrackLength,
  loadRemoteLibrary,
  queueRemoteSong,
  remoteErrorMessage,
  remoteSession,
  type RemoteLibrary,
  type RemoteSong,
} from '@/lib/listener-remote';
import { StatusNote } from './StatusNote';

export function LibraryView({ canAdd, expire, refresh }: {
  readonly canAdd: boolean;
  readonly expire: (error: unknown) => boolean;
  readonly refresh: () => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [library, setLibrary] = useState<RemoteLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const expireRef = useRef(expire);
  expireRef.current = expire;

  useEffect(() => {
    const id = window.setTimeout(() => {
      setQuery(search.trim().slice(0, 200));
      setPage(1);
    }, 300);
    return () => window.clearTimeout(id);
  }, [search]);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    void loadRemoteLibrary(query, page).then(
      (data) => { if (!stale) { setLibrary(data); setError(null); } },
      (err: unknown) => {
        if (stale || expireRef.current(err)) return;
        setError(remoteErrorMessage(err));
      },
    ).finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [query, page]);

  const add = (song: RemoteSong) => {
    if (!canAdd || lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice(null);
    setError(null);
    void enqueueRemoteMutation(() => queueRemoteSong(song.id)).then(
      async () => {
        if (!remoteSession()) return;
        setNotice(`Added ${song.title} to the queue.`);
        await refresh();
      },
      (err: unknown) => { if (!expire(err)) setError(remoteErrorMessage(err)); },
    ).finally(() => { lock.current = false; setBusy(false); });
  };

  const songs = library?.songs ?? [];
  return (
    <Card>
      <CardContent className="p-4">
        <section aria-labelledby="library" className="space-y-3">
          <h2 id="library" className="text-base font-semibold">Library</h2>
          <form role="search" onSubmit={(event) => event.preventDefault()}>
            <Input
              id="remote-search"
              value={search}
              maxLength={200}
              enterKeyHint="search"
              placeholder="Search songs"
              aria-label="Search songs"
              className="h-11"
              onChange={(event) => setSearch(event.target.value)}
            />
          </form>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {notice && <StatusNote>{notice}</StatusNote>}
          <LibrarySongs songs={songs} page={page} loading={loading} library={library} canAdd={canAdd} busy={busy} add={add} />
          {(page > 1 || songs.length >= 25) && (
            <div className="flex gap-2">
              {page > 1 && (
                <Button type="button" variant="outline" className="h-11 flex-1" disabled={loading} onClick={() => setPage((n) => n - 1)}>
                  Previous page
                </Button>
              )}
              {songs.length >= 25 && (
                <Button type="button" variant="outline" className="h-11 flex-1" disabled={loading} onClick={() => setPage((n) => n + 1)}>
                  Next page
                </Button>
              )}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

function LibrarySongs({ songs, page, loading, library, canAdd, busy, add }: {
  readonly songs: RemoteSong[];
  readonly page: number;
  readonly loading: boolean;
  readonly library: RemoteLibrary | null;
  readonly canAdd: boolean;
  readonly busy: boolean;
  readonly add: (song: RemoteSong) => void;
}) {
  if (loading && !library) return <StatusNote>Searching the library…</StatusNote>;
  if (songs.length === 0) {
    const empty = page > 1 ? 'No more songs.' : 'No songs found.';
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ul aria-label="Songs" className="space-y-1.5">
      {songs.map((song) => (
        <li key={song.id} className="flex items-center gap-2 rounded-md border bg-card p-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{song.title}</p>
            {song.artist && <p className="truncate text-xs text-muted-foreground">{song.artist}</p>}
          </div>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{formatTrackLength(song.duration) ?? ''}</span>
          {canAdd && (
            <Button type="button" variant="outline" size="icon" className="h-11 w-11" disabled={busy}
              aria-label={`Add ${song.title} to the queue`} onClick={() => add(song)}>
              <Plus aria-hidden="true" />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
