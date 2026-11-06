import { useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  enqueueRemoteMutation,
  formatTrackLength,
  queueRemoteSearchResult,
  remoteErrorMessage,
  remoteSearchQueryError,
  remoteSearchQueueErrorMessage,
  remoteSession,
  searchRemoteMusic,
  type RemoteSearchResult,
} from '@/lib/listener-remote';
import { StatusNote } from './StatusNote';

export function SearchView({ expire, refresh }: {
  readonly expire: (error: unknown) => boolean;
  readonly refresh: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RemoteSearchResult[] | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const searchLock = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const errorId = useId();
  const hintId = useId();
  const statusId = useId();

  useLayoutEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
    else if (notice) noticeRef.current?.focus({ preventScroll: true });
  }, [error, notice]);

  useLayoutEffect(() => {
    if (searching || results === null) return;
    resultsRef.current?.focus({ preventScroll: true });
  }, [results, searching]);

  const runSearch = () => {
    const problem = remoteSearchQueryError(query);
    if (problem) {
      flushSync(() => {
        setError(problem);
        setNotice(null);
      });
      errorRef.current?.focus({ preventScroll: true });
      return;
    }
    if (searchLock.current) return;
    searchLock.current = true;
    setSearching(true);
    setError(null);
    setNotice(null);
    void searchRemoteMusic(query).then(
      (data) => {
        if (!remoteSession()) return;
        setResults(data.results);
        setExpiresAt(data.expiresAt);
      },
      (err: unknown) => {
        if (expire(err)) return;
        setError(remoteErrorMessage(err));
        setResults(null);
        setExpiresAt(null);
      },
    ).finally(() => {
      searchLock.current = false;
      setSearching(false);
    });
  };

  const add = (row: RemoteSearchResult) => {
    if (lock.current) return;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      flushSync(() => {
        setError('Those search results have expired. Search again.');
        setNotice(null);
        setResults(null);
        setExpiresAt(null);
      });
      errorRef.current?.focus({ preventScroll: true });
      return;
    }
    lock.current = true;
    setBusy(true);
    setNotice(null);
    setError(null);
    void enqueueRemoteMutation(() => queueRemoteSearchResult(row.id)).then(
      async () => {
        if (!remoteSession()) return;
        setResults((prev) => (prev ? prev.filter((item) => item.id !== row.id) : prev));
        setNotice(`Added ${row.title} to the queue.`);
        await refresh();
      },
      (err: unknown) => {
        if (!expire(err)) setError(remoteSearchQueueErrorMessage(err));
      },
    ).finally(() => {
      lock.current = false;
      setBusy(false);
    });
  };

  const list = results ?? [];

  return (
    <Card>
      <CardContent className="p-4">
        <section aria-labelledby="music-search" className="space-y-3">
          <h2 id="music-search" className="text-base font-semibold">Search</h2>
          <p id={hintId} className="text-sm text-foreground/80">
            Find a song that is not in the library and add it to the queue.
          </p>
          <form
            role="search"
            className="space-y-2"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              runSearch();
            }}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="remote-music-search"
                value={query}
                maxLength={100}
                enterKeyHint="search"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Song or artist"
                aria-label="Search for a song"
                aria-busy={searching}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : `${hintId} ${statusId}`}
                className="h-11 min-h-11 sm:flex-1"
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (error) setError(null);
                }}
              />
              <Button
                type="submit"
                className="h-11 min-h-11 w-full sm:w-auto"
                disabled={searching || query.trim().length < 2}
              >
                {searching ? 'Searching…' : 'Search'}
              </Button>
            </div>
          </form>
          <p id={statusId} className="sr-only" aria-live="polite">
            {searching
              ? 'Searching for songs.'
              : results
                ? `${list.length} search results.`
                : 'No search yet.'}
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
          {notice && (
            <p ref={noticeRef} tabIndex={-1} className="outline-none">
              <StatusNote>{notice}</StatusNote>
            </p>
          )}
          <div
            ref={resultsRef}
            tabIndex={-1}
            data-testid="search-results"
            className="scroll-mt-4 space-y-3 outline-none"
            aria-busy={searching}
          >
            {searching && results === null && <StatusNote>Searching…</StatusNote>}
            {searching && results !== null && <StatusNote>Updating results…</StatusNote>}
            {!searching && results !== null && list.length === 0 && (
              <p className="text-sm text-foreground/80">No songs found.</p>
            )}
            {list.length > 0 && (
              <ul aria-label="Search results" className="space-y-1.5">
                {list.map((row) => (
                  <li key={row.id} className="flex items-center gap-2 rounded-md border bg-card p-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" title={row.title}>{row.title}</p>
                      {row.artist && (
                        <p className="truncate text-xs text-foreground/75" title={row.artist}>{row.artist}</p>
                      )}
                    </div>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-foreground/75">
                      {formatTrackLength(row.duration) ?? ''}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-11 w-11 min-h-11 min-w-11"
                      disabled={busy || searching}
                      aria-label={`Add ${row.title} to the queue`}
                      onClick={() => add(row)}
                    >
                      <Plus aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
