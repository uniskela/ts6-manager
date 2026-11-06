import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  enqueueRemoteMutation,
  formatTrackLength,
  loadRemotePlaylistSongs,
  loadRemotePlaylists,
  queueRemoteSong,
  remoteErrorMessage,
  remoteSession,
  type RemotePlaylist,
  type RemotePlaylistPage,
  type RemotePlaylistSongsPage,
  type RemoteSong,
} from '@/lib/listener-remote';
import { StatusNote } from './StatusNote';

export function PlaylistsView({ canAdd, expire, refresh }: {
  readonly canAdd: boolean;
  readonly expire: (error: unknown) => boolean;
  readonly refresh: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<RemotePlaylist | null>(null);

  if (selected) {
    return (
      <PlaylistSongsView
        playlist={selected}
        canAdd={canAdd}
        expire={expire}
        refresh={refresh}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <PlaylistListView
      expire={expire}
      onOpen={setSelected}
    />
  );
}

function PlaylistListView({ expire, onOpen }: {
  readonly expire: (error: unknown) => boolean;
  readonly onOpen: (playlist: RemotePlaylist) => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<RemotePlaylistPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
    void loadRemotePlaylists(query, page).then(
      (data) => {
        if (stale || id !== requestId.current) return;
        setList(data);
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
    const searchInput = document.getElementById('remote-playlist-search');
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
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  const playlists = list?.playlists ?? [];
  const showStale = loading && list !== null;

  return (
    <Card>
      <CardContent className="p-4">
        <section aria-labelledby="playlists" className="space-y-3">
          <h2 id="playlists" className="text-base font-semibold">Playlists</h2>
          <form role="search" onSubmit={(event) => event.preventDefault()}>
            <Input
              id="remote-playlist-search"
              value={search}
              maxLength={200}
              enterKeyHint="search"
              placeholder="Search playlists"
              aria-label="Search playlists"
              aria-busy={loading}
              aria-describedby={statusId}
              className="h-11 min-h-11"
              onChange={(event) => setSearch(event.target.value)}
            />
          </form>
          <p id={statusId} className="sr-only" aria-live="polite">
            {loading ? 'Updating playlist results.' : `${playlists.length} playlists on this page.`}
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
          <div
            ref={resultsRef}
            tabIndex={-1}
            data-testid="playlist-results"
            className="scroll-mt-4 space-y-3 outline-none"
            aria-busy={loading}
          >
            {showStale && <StatusNote>Updating results…</StatusNote>}
            <PlaylistRows playlists={playlists} page={page} loading={loading} list={list} onOpen={onOpen} />
          </div>
          {(page > 1 || playlists.length >= 25) && (
            <div className="flex gap-2">
              {page > 1 && (
                <Button type="button" variant="outline" className="h-11 min-h-11 flex-1" disabled={loading} onClick={() => setPage((n) => n - 1)}>
                  Previous page
                </Button>
              )}
              {playlists.length >= 25 && (
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

function PlaylistRows({ playlists, page, loading, list, onOpen }: {
  readonly playlists: RemotePlaylist[];
  readonly page: number;
  readonly loading: boolean;
  readonly list: RemotePlaylistPage | null;
  readonly onOpen: (playlist: RemotePlaylist) => void;
}) {
  if (loading && !list) return <StatusNote>Searching playlists…</StatusNote>;
  if (playlists.length === 0) {
    const empty = page > 1 ? 'No more playlists.' : 'No playlists found.';
    return <p className="text-sm text-foreground/80">{empty}</p>;
  }
  return (
    <ul aria-label="Playlists" className="space-y-1.5">
      {playlists.map((playlist) => {
        const length = formatTrackLength(playlist.duration);
        const meta = [
          `${playlist.trackCount} track${playlist.trackCount === 1 ? '' : 's'}`,
          length,
        ].filter(Boolean).join(' · ');
        return (
          <li key={playlist.id}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md border bg-card p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onOpen(playlist)}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={playlist.name}>{playlist.name}</p>
                <p className="truncate text-xs text-foreground/75">{meta}</p>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PlaylistSongsView({ playlist, canAdd, expire, refresh, onBack }: {
  readonly playlist: RemotePlaylist;
  readonly canAdd: boolean;
  readonly expire: (error: unknown) => boolean;
  readonly refresh: () => Promise<void>;
  readonly onBack: () => void;
}) {
  const [page, setPage] = useState(1);
  const [songsPage, setSongsPage] = useState<RemotePlaylistSongsPage | null>(null);
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
  const headingId = useId();

  useEffect(() => {
    let stale = false;
    const id = ++requestId.current;
    setLoading(true);
    void loadRemotePlaylistSongs(playlist.id, page).then(
      (data) => {
        if (stale || id !== requestId.current) return;
        setSongsPage(data);
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
  }, [playlist.id, page]);

  useLayoutEffect(() => {
    if (loading) return;
    if (focusKeyRef.current === String(page)) return;
    focusKeyRef.current = String(page);
    const node = resultsRef.current;
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    node.focus({ preventScroll: true });
  }, [page, loading]);

  useLayoutEffect(() => {
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

  const songs = songsPage?.songs ?? [];
  const showStale = loading && songsPage !== null;
  const title = songsPage?.playlist.name ?? playlist.name;

  return (
    <Card>
      <CardContent className="p-4">
        <section aria-labelledby={headingId} className="space-y-3">
          <div className="flex items-start gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-11 w-11 min-h-11 min-w-11 shrink-0"
              aria-label="Back to playlists"
              onClick={onBack}
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
            <div className="min-w-0 flex-1">
              <h2 id={headingId} className="truncate text-base font-semibold" title={title}>{title}</h2>
              <p className="text-xs text-foreground/75">
                {(songsPage?.playlist.trackCount ?? playlist.trackCount)} track
                {(songsPage?.playlist.trackCount ?? playlist.trackCount) === 1 ? '' : 's'}
              </p>
            </div>
          </div>
          <p id={statusId} className="sr-only" aria-live="polite">
            {loading ? 'Updating playlist songs.' : `${songs.length} songs on this page.`}
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
            data-testid="playlist-song-results"
            className="scroll-mt-4 space-y-3 outline-none"
            aria-busy={loading}
            aria-describedby={statusId}
          >
            {showStale && <StatusNote>Updating results…</StatusNote>}
            <PlaylistSongRows
              songs={songs}
              page={page}
              loading={loading}
              songsPage={songsPage}
              canAdd={canAdd}
              busy={busy}
              add={add}
            />
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

function PlaylistSongRows({ songs, page, loading, songsPage, canAdd, busy, add }: {
  readonly songs: RemoteSong[];
  readonly page: number;
  readonly loading: boolean;
  readonly songsPage: RemotePlaylistSongsPage | null;
  readonly canAdd: boolean;
  readonly busy: boolean;
  readonly add: (song: RemoteSong) => void;
}) {
  if (loading && !songsPage) return <StatusNote>Loading playlist songs…</StatusNote>;
  if (songs.length === 0) {
    const empty = page > 1 ? 'No more songs.' : 'No songs in this playlist.';
    return <p className="text-sm text-foreground/80">{empty}</p>;
  }
  return (
    <ul aria-label="Playlist songs" className="space-y-1.5">
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
