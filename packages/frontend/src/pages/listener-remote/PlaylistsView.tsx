import { useId, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  formatTrackLength,
  loadRemotePlaylistSongs,
  loadRemotePlaylists,
  type RemotePlaylist,
  type RemoteVote,
} from '@/lib/listener-remote';
import { PlaylistRequestControl, type PlaylistRequestAccess } from './PlaylistRequestControl';
import { StatusNote } from './StatusNote';
import {
  RemoteErrorAlert,
  RemotePageControls,
  RemoteSongRows,
  useQueueRemoteSong,
  useRemotePageLoad,
  useRemoteSearchPageLoad,
  useRemoteSearchQuery,
} from './remote-paged-list';

export function PlaylistsView({ canAdd, request, expire, refresh, onVote }: {
  readonly canAdd: boolean;
  readonly request: PlaylistRequestAccess;
  readonly expire: (error: unknown) => boolean;
  readonly refresh: () => Promise<void>;
  readonly onVote: (vote: RemoteVote) => void;
}) {
  const [selected, setSelected] = useState<RemotePlaylist | null>(null);

  if (selected) {
    return (
      <PlaylistSongsView
        playlist={selected}
        canAdd={canAdd}
        request={request}
        expire={expire}
        refresh={refresh}
        onVote={onVote}
        onBack={() => setSelected(null)}
      />
    );
  }

  return <PlaylistListView expire={expire} onOpen={setSelected} />;
}

function PlaylistListView({ expire, onOpen }: {
  readonly expire: (error: unknown) => boolean;
  readonly onOpen: (playlist: RemotePlaylist) => void;
}) {
  const [search, setSearch] = useState('');
  const { query, page, setPage } = useRemoteSearchQuery(search);
  const {
    data: list,
    error,
    loading,
    errorId,
    statusId,
    resultsRef,
    errorRef,
  } = useRemoteSearchPageLoad(
    () => loadRemotePlaylists(query, page),
    [query, page],
    expire,
    'remote-playlist-search',
  );
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
          <RemoteErrorAlert error={error} errorId={errorId} errorRef={errorRef} />
          <div
            ref={resultsRef}
            tabIndex={-1}
            data-testid="playlist-results"
            className="scroll-mt-4 space-y-3 outline-none"
            aria-busy={loading}
          >
            {showStale && <StatusNote>Updating results…</StatusNote>}
            <PlaylistRows playlists={playlists} page={page} loading={loading} hasData={list !== null} onOpen={onOpen} />
          </div>
          <RemotePageControls page={page} itemCount={playlists.length} loading={loading} setPage={setPage} />
        </section>
      </CardContent>
    </Card>
  );
}

function PlaylistRows({ playlists, page, loading, hasData, onOpen }: {
  readonly playlists: RemotePlaylist[];
  readonly page: number;
  readonly loading: boolean;
  readonly hasData: boolean;
  readonly onOpen: (playlist: RemotePlaylist) => void;
}) {
  if (loading && !hasData) return <StatusNote>Searching playlists…</StatusNote>;
  if (playlists.length === 0) {
    return <p className="text-sm text-foreground/80">{page > 1 ? 'No more playlists.' : 'No playlists found.'}</p>;
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

function PlaylistSongsView({ playlist, canAdd, request, expire, refresh, onVote, onBack }: {
  readonly playlist: RemotePlaylist;
  readonly canAdd: boolean;
  readonly request: PlaylistRequestAccess;
  readonly expire: (error: unknown) => boolean;
  readonly refresh: () => Promise<void>;
  readonly onVote: (vote: RemoteVote) => void;
  readonly onBack: () => void;
}) {
  const [page, setPage] = useState(1);
  const {
    data: songsPage,
    error,
    setError,
    loading,
    errorId,
    statusId,
    resultsRef,
    errorRef,
  } = useRemotePageLoad(
    () => loadRemotePlaylistSongs(playlist.id, page),
    [playlist.id, page],
    expire,
  );
  const { busy, notice, add } = useQueueRemoteSong(canAdd, expire, refresh, setError);
  const songs = songsPage?.songs ?? [];
  const showStale = loading && songsPage !== null;
  const title = songsPage?.playlist.name ?? playlist.name;
  const trackCount = songsPage?.playlist.trackCount ?? playlist.trackCount;
  const headingId = useId();

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
                {trackCount} track{trackCount === 1 ? '' : 's'}
              </p>
            </div>
          </div>
          {songsPage && (
            <PlaylistRequestControl
              playlist={songsPage.playlist}
              access={request}
              expire={expire}
              refresh={refresh}
              onVote={onVote}
            />
          )}
          <p id={statusId} className="sr-only" aria-live="polite">
            {loading ? 'Updating playlist songs.' : `${songs.length} songs on this page.`}
          </p>
          <RemoteErrorAlert error={error} errorId={errorId} errorRef={errorRef} />
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
            <RemoteSongRows
              songs={songs}
              page={page}
              loading={loading}
              hasData={songsPage !== null}
              canAdd={canAdd}
              busy={busy}
              add={add}
              loadingLabel="Loading playlist songs…"
              emptyFirst="No songs in this playlist."
              emptyMore="No more songs."
              listLabel="Playlist songs"
            />
          </div>
          <RemotePageControls page={page} itemCount={songs.length} loading={loading} setPage={setPage} />
        </section>
      </CardContent>
    </Card>
  );
}
