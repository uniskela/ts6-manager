import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type Ref,
  type RefObject,
  type SetStateAction,
} from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  enqueueRemoteMutation,
  formatTrackLength,
  queueRemoteSong,
  remoteErrorMessage,
  remoteSession,
  type RemoteSong,
} from '@/lib/listener-remote';
import { StatusNote } from './StatusNote';

const PAGE_SIZE = 25;

/** Debounced search text + page for remote list endpoints. */
export function useRemoteSearchQuery(search: string): {
  query: string;
  page: number;
  setPage: Dispatch<SetStateAction<number>>;
} {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const id = window.setTimeout(() => {
      setQuery(search.trim().slice(0, 200));
      setPage(1);
    }, 300);
    return () => window.clearTimeout(id);
  }, [search]);
  return { query, page, setPage };
}

/** Load a remote page; ignore stale responses; map errors through expire(). */
export function useRemotePageLoad<T>(
  load: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
  expire: (error: unknown) => boolean,
): {
  data: T | null;
  error: string | null;
  setError: (value: string | null) => void;
  loading: boolean;
  errorId: string;
  statusId: string;
  resultsRef: RefObject<HTMLDivElement>;
  errorRef: RefObject<HTMLParagraphElement>;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const expireRef = useRef(expire);
  const resultsRef = useRef<HTMLDivElement>(null!);
  const errorRef = useRef<HTMLParagraphElement>(null!);
  const requestId = useRef(0);
  const focusKeyRef = useRef<string | null>(null);
  expireRef.current = expire;
  const errorId = useId();
  const statusId = useId();
  const pageKey = String(deps[deps.length - 1] ?? '');

  useEffect(() => {
    let stale = false;
    const id = ++requestId.current;
    setLoading(true);
    void load().then(
      (next) => {
        if (stale || id !== requestId.current) return;
        setData(next);
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
    // Caller passes an explicit deps list for the load identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional external deps
  }, deps);

  useLayoutEffect(() => {
    if (loading) return;
    if (focusKeyRef.current === pageKey) return;
    focusKeyRef.current = pageKey;
    const node = resultsRef.current;
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    node.focus({ preventScroll: true });
  }, [pageKey, loading]);

  useLayoutEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  return { data, error, setError, loading, errorId, statusId, resultsRef, errorRef };
}

/** Like useRemotePageLoad, but skips moving focus while the named search input is active. */
export function useRemoteSearchPageLoad<T>(
  load: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
  expire: (error: unknown) => boolean,
  searchInputId: string,
): ReturnType<typeof useRemotePageLoad<T>> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const expireRef = useRef(expire);
  const resultsRef = useRef<HTMLDivElement>(null!);
  const errorRef = useRef<HTMLParagraphElement>(null!);
  const requestId = useRef(0);
  const focusKeyRef = useRef<string | null>(null);
  expireRef.current = expire;
  const errorId = useId();
  const statusId = useId();
  const page = deps[deps.length - 1];
  const pageKey = String(page ?? '');

  useEffect(() => {
    let stale = false;
    const id = ++requestId.current;
    setLoading(true);
    void load().then(
      (next) => {
        if (stale || id !== requestId.current) return;
        setData(next);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional external deps
  }, deps);

  useLayoutEffect(() => {
    if (loading) return;
    // Page changes only — search refreshes must not steal the search input.
    if (focusKeyRef.current === pageKey) return;
    const searchInput = document.getElementById(searchInputId);
    if (searchInput && document.activeElement === searchInput) {
      focusKeyRef.current = pageKey;
      return;
    }
    focusKeyRef.current = pageKey;
    const node = resultsRef.current;
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    node.focus({ preventScroll: true });
  }, [pageKey, loading, searchInputId]);

  useLayoutEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  return { data, error, setError, loading, errorId, statusId, resultsRef, errorRef };
}

export function useQueueRemoteSong(
  canAdd: boolean,
  expire: (error: unknown) => boolean,
  refresh: () => Promise<void>,
  setError: (value: string | null) => void,
): {
  busy: boolean;
  notice: string | null;
  add: (song: RemoteSong) => void;
} {
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

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

  return { busy, notice, add };
}

export function RemotePageControls({
  page,
  itemCount,
  loading,
  setPage,
}: {
  readonly page: number;
  readonly itemCount: number;
  readonly loading: boolean;
  readonly setPage: Dispatch<SetStateAction<number>>;
}): ReactNode {
  if (!(page > 1 || itemCount >= PAGE_SIZE)) return null;
  return (
    <div className="flex gap-2">
      {page > 1 && (
        <Button type="button" variant="outline" className="h-11 min-h-11 flex-1" disabled={loading} onClick={() => setPage((n) => n - 1)}>
          Previous page
        </Button>
      )}
      {itemCount >= PAGE_SIZE && (
        <Button type="button" variant="outline" className="h-11 min-h-11 flex-1" disabled={loading} onClick={() => setPage((n) => n + 1)}>
          Next page
        </Button>
      )}
    </div>
  );
}

export function RemoteErrorAlert({
  error,
  errorId,
  errorRef,
}: {
  readonly error: string | null;
  readonly errorId: string;
  readonly errorRef: Ref<HTMLParagraphElement>;
}): ReactNode {
  if (!error) return null;
  return (
    <p
      ref={errorRef}
      id={errorId}
      role="alert"
      tabIndex={-1}
      className="text-sm text-destructive outline-none"
    >
      {error}
    </p>
  );
}

export function RemoteSongRows({
  songs,
  page,
  loading,
  hasData,
  canAdd,
  busy,
  add,
  loadingLabel,
  emptyFirst,
  emptyMore,
  listLabel = 'Songs',
}: {
  readonly songs: RemoteSong[];
  readonly page: number;
  readonly loading: boolean;
  readonly hasData: boolean;
  readonly canAdd: boolean;
  readonly busy: boolean;
  readonly add: (song: RemoteSong) => void;
  readonly loadingLabel: string;
  readonly emptyFirst: string;
  readonly emptyMore: string;
  readonly listLabel?: string;
}): ReactNode {
  if (loading && !hasData) return <StatusNote>{loadingLabel}</StatusNote>;
  if (songs.length === 0) {
    return <p className="text-sm text-foreground/80">{page > 1 ? emptyMore : emptyFirst}</p>;
  }
  return (
    <ul aria-label={listLabel} className="space-y-1.5">
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
