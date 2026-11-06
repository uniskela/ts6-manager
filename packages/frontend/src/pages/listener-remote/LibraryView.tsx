import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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
  const resultsRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const requestId = useRef(0);
  const focusKeyRef = useRef<string | null>(null);
  expireRef.current = expire;
  const errorId = useId();
  const statusId = useId();

  useEffect(() => {
    const id = window.setTimeout(() => {
      setQuery(search.trim().slice(0, 200));
      setPage(1);
    }, 300);
    return () => window.clearTimeout(id);
  }, [search]);

  useEffect(() => {
    let stale = false;
    const id = ++requestId.current;
    setLoading(true);
    void loadRemoteLibrary(query, page).then(
      (data) => {
        if (stale || id !== requestId.current) return;
        setLibrary(data);
        setError(null);
      },
      (err: unknown) => {
        if (stale || id !== requestId.current || expireRef.current(err)) return;
        setError(remoteErrorMessage(err));
      },
    ).finally(() => {
      if (!stale && id === requestId.current) setLoading(false);
    });
    return () => { stale = true; };
  }, [query, page]);

  useLayoutEffect(() => {
    if (loading) return;
    // Page changes only — search refreshes must not steal the search input.
    if (focusKeyRef.current === String(page)) return;
    const searchInput = document.getElementById('remote-search');
    if (searchInput && document.activeElement === searchInput) {
      focusKeyRef.current = String(page);
      return;
    }
    focusKeyRef.current = String(page);
    const node = resultsRef.current;
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    node.focus({ preventScroll: true });
  }, [page, loading]);

  useLayoutEffect(() => {
    // Errors take focus; success stays an aria-live StatusNote so Add stays in the list.
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);

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
  const showStale = loading && library !== null;

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
              aria-busy={loading}
              aria-describedby={statusId}
              className="h-11 min-h-11"
              onChange={(event) => setSearch(event.target.value)}
            />
          </form>
          <p id={statusId} className="sr-only" aria-live="polite">
            {loading ? 'Updating library results.' : `${songs.length} songs on this page.`}
          </p>
          {error && (
            <p
              ref={errorRef}
              id={errorId}
              role="alert"
              tabIndex={-1}
              className="text-sm text-destructive outline-none"
            >
              {error}
            </p>
          )}
          {notice && <StatusNote>{notice}</StatusNote>}
          <div
            ref={resultsRef}
            tabIndex={-1}
            data-testid="library-results"
            className="scroll-mt-4 space-y-3 outline-none"
            aria-busy={loading}
          >
            {showStale && <StatusNote>Updating results…</StatusNote>}
            <LibrarySongs songs={songs} page={page} loading={loading} library={library} canAdd={canAdd} busy={busy} add={add} />
          </div>
          {(page > 1 || songs.length >= 25) && (
            <div className="flex gap-2">
              {page > 1 && (
                <Button type="button" variant="outline" className="h-11 min-h-11 flex-1" disabled={loading} onClick={() => setPage((n) => n - 1)}>
                  Previous page
                </Button>
              )}
              {songs.length >= 25 && (
                <Button type="button" variant="outline" className="h-11 min-h-11 flex-1" disabled={loading} onClick={() => setPage((n) => n + 1)}>
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
    return <p className="text-sm text-foreground/80">{empty}</p>;
  }
  return (
    <ul aria-label="Songs" className="space-y-1.5">
      {songs.map((song) => (
        <li key={song.id} className="flex items-center gap-2 rounded-md border bg-card p-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" title={song.title}>{song.title}</p>
            {song.artist && (
              <p className="truncate text-xs text-foreground/75" title={song.artist}>{song.artist}</p>
            )}
          </div>
          <span className="shrink-0 font-mono text-xs tabular-nums text-foreground/75">{formatTrackLength(song.duration) ?? ''}</span>
          {canAdd && (
            <Button type="button" variant="outline" size="icon" className="h-11 w-11 min-h-11 min-w-11" disabled={busy}
              aria-label={`Add ${song.title} to the queue`} onClick={() => add(song)}>
              <Plus aria-hidden="true" />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
