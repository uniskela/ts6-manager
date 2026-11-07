import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { loadRemoteLibrary } from '@/lib/listener-remote';
import { StatusNote } from './StatusNote';
import {
  RemoteErrorAlert,
  RemotePageControls,
  RemoteSongRows,
  useQueueRemoteSong,
  useRemoteSearchPageLoad,
  useRemoteSearchQuery,
} from './remote-paged-list';

export function LibraryView({ canAdd, expire, refresh }: {
  readonly canAdd: boolean;
  readonly expire: (error: unknown) => boolean;
  readonly refresh: () => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const { query, page, setPage } = useRemoteSearchQuery(search);
  const {
    data: library,
    error,
    setError,
    loading,
    errorId,
    statusId,
    resultsRef,
    errorRef,
  } = useRemoteSearchPageLoad(
    () => loadRemoteLibrary(query, page),
    [query, page],
    expire,
    'remote-search',
  );
  const { busy, notice, add } = useQueueRemoteSong(canAdd, expire, refresh, setError);
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
          <RemoteErrorAlert error={error} errorId={errorId} errorRef={errorRef} />
          {notice && <StatusNote>{notice}</StatusNote>}
          <div
            ref={resultsRef}
            tabIndex={-1}
            data-testid="library-results"
            className="scroll-mt-4 space-y-3 outline-none"
            aria-busy={loading}
          >
            {showStale && <StatusNote>Updating results…</StatusNote>}
            <RemoteSongRows
              songs={songs}
              page={page}
              loading={loading}
              hasData={library !== null}
              canAdd={canAdd}
              busy={busy}
              add={add}
              loadingLabel="Searching the library…"
              emptyFirst="No songs found."
              emptyMore="No more songs."
            />
          </div>
          <RemotePageControls page={page} itemCount={songs.length} loading={loading} setPage={setPage} />
        </section>
      </CardContent>
    </Card>
  );
}
