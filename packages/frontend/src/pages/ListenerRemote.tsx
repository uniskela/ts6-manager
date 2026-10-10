import { useEffect, useRef, useState } from 'react';
import { Music, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { remoteLaunchToken } from '@/lib/listener-remote-launch';
import {
  REMOTE_POLL_MS,
  RemoteHttpError,
  enqueueRemoteMutation,
  exchangeRemoteToken,
  formatTrackLength,
  loadRemoteLibrary,
  loadRemoteState,
  playbackSummary,
  queueRemoteSong,
  remoteErrorMessage,
  remoteMediaUrlError,
  remoteSession,
  requestRemoteUrl,
  shouldPollRemote,
  type RemoteLibrary,
  type RemoteSong,
  type RemoteState,
} from '@/lib/listener-remote';

type Phase = { kind: 'opening' } | { kind: 'need-link' } | { kind: 'ended'; message: string } | { kind: 'ready' };

const STATUS_LABEL: Record<string, string> = { playing: 'Playing', paused: 'Paused', connected: 'Connected' };

function initialPhase(): Phase {
  if (remoteLaunchToken()) return { kind: 'opening' };
  if (remoteSession()) return { kind: 'ready' };
  return { kind: 'need-link' };
}

export default function ListenerRemote() {
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    document.title = 'Listener remote';
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex';
    const referrer = document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    document.head.append(robots, referrer);
    return () => {
      robots.remove();
      referrer.remove();
      document.title = 'TeamSpeak 6 Manager';
    };
  }, []);

  useEffect(() => {
    const onToken = () => setGeneration((n) => n + 1);
    window.addEventListener('ts6-remote-token', onToken);
    return () => window.removeEventListener('ts6-remote-token', onToken);
  }, []);

  useEffect(() => {
    const token = remoteLaunchToken();
    if (generation === 0 && remoteSession()) {
      setPhase({ kind: 'ready' });
      return;
    }
    if (!token) {
      setPhase({ kind: 'need-link' });
      return;
    }
    let alive = true;
    setPhase({ kind: 'opening' });
    void exchangeRemoteToken(token).then(
      () => { if (alive) setPhase({ kind: 'ready' }); },
      (error: unknown) => { if (alive) setPhase({ kind: 'ended', message: remoteErrorMessage(error) }); },
    );
    return () => { alive = false; };
  }, [generation]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-3 py-4" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
      {phase.kind === 'ready'
        ? <RemoteController onEnded={(message) => setPhase({ kind: 'ended', message })} />
        : <Gate phase={phase} />}
    </main>
  );
}

function Gate({ phase }: { phase: Exclude<Phase, { kind: 'ready' }> }) {
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">Listener remote</h1>
      {phase.kind === 'opening' && <p role="status" className="text-sm text-muted-foreground">Opening your remote…</p>}
      {phase.kind === 'need-link' && (
        <p className="text-sm text-muted-foreground">Type !remote in the bot's channel. The bot sends a private link to this page.</p>
      )}
      {phase.kind === 'ended' && (
        <>
          <p role="alert" className="text-sm text-destructive">{phase.message}</p>
          <p className="text-sm text-muted-foreground">Type !remote in the bot's channel. The bot sends a private link to this page.</p>
        </>
      )}
    </div>
  );
}

function RemoteController({ onEnded }: { onEnded(message: string): void }) {
  const [state, setState] = useState<RemoteState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState(true);
  const lastPoll = useRef(0);
  const loadRef = useRef<(force?: boolean) => Promise<void>>(async () => {});

  const loadState = async (force = false) => {
    const visible = document.visibilityState === 'visible';
    if (!force && !shouldPollRemote(visible, lastPoll.current, Date.now())) return;
    if (!remoteSession()) {
      onEnded('Remote access is invalid or expired');
      return;
    }
    lastPoll.current = Date.now();
    try {
      const next = await loadRemoteState();
      if (!remoteSession()) return;
      setState(next);
      setStateError(null);
    } catch (error) {
      if (error instanceof RemoteHttpError && (error.status === 401 || !remoteSession())) {
        onEnded(error.message);
        return;
      }
      setStateError(remoteErrorMessage(error));
    } finally {
      setLoadingState(false);
    }
  };
  loadRef.current = loadState;

  useEffect(() => {
    let stopped = false;
    const tick = () => { if (!stopped) void loadRef.current(); };
    tick();
    const id = window.setInterval(tick, REMOTE_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  const expire = (error: unknown) => {
    if (error instanceof RemoteHttpError && error.status === 401) {
      onEnded(error.message);
      return true;
    }
    if (error instanceof RemoteHttpError && error.status === 403) void loadRef.current(true);
    return false;
  };

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Listener remote</p>
          <h1 className="truncate text-lg font-semibold">{state?.bot.name ?? 'Listener remote'}</h1>
        </div>
        {state && (
          <Badge variant={state.bot.status === 'playing' ? 'default' : 'secondary'} className="shrink-0">
            {STATUS_LABEL[state.bot.status] ?? 'Connected'}
          </Badge>
        )}
      </header>

      <NowPlaying state={state} loading={loadingState} error={stateError} />
      <UpNext state={state} loading={loadingState} />
      {state?.permissions.searchLibrary && (
        <Library canAdd={state.permissions.addToQueue} expire={expire} refresh={() => loadRef.current(true)} />
      )}
      {state?.permissions.requestUrl && <UrlRequest expire={expire} refresh={() => loadRef.current(true)} />}
    </div>
  );
}

function NowPlaying({ state, loading, error }: { state: RemoteState | null; loading: boolean; error: string | null }) {
  const track = state?.nowPlaying ?? null;
  const summary = playbackSummary(track, state?.bot.status ?? 'connected');
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <h2 id="now-playing" className="text-base font-semibold">Now playing</h2>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {loading && !state ? (
          <p role="status" className="text-sm text-muted-foreground">Loading the remote…</p>
        ) : !track ? (
          state || !error ? <p className="text-sm text-muted-foreground">Nothing is playing.</p> : null
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Music className="h-6 w-6" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-base font-semibold">{track.title}</p>
                {track.artist && <p className="truncate text-sm text-muted-foreground">{track.artist}</p>}
              </div>
            </div>
            <div
              className={`h-1.5 rounded-full ${summary.playing ? 'animate-pulse bg-primary/70' : 'bg-muted'}`}
              role="progressbar"
              aria-label="Playback progress"
              aria-valuetext={summary.label}
            />
            <div className="flex justify-between font-mono text-xs tabular-nums text-muted-foreground">
              <span>{summary.playing ? 'Playing' : state?.bot.status === 'paused' ? 'Paused' : 'Connected'}</span>
              <span>{summary.length ?? 'Live'}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UpNext({ state, loading }: { state: RemoteState | null; loading: boolean }) {
  const items = state?.upNext ?? [];
  const count = state?.upNextCount ?? items.length;
  return (
    <section aria-labelledby="up-next" className="space-y-2">
      <h2 id="up-next" className="text-sm font-semibold">Up next{state ? ` (${count})` : ''}</h2>
      {!state ? (
        loading ? <p role="status" className="text-sm text-muted-foreground">Loading the queue…</p> : null
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is queued.</p>
      ) : (
        <ol aria-label="Up next" className="max-h-64 space-y-1.5 overflow-y-auto">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-2 rounded-md border bg-card p-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.title}</p>
                {item.artist && <p className="truncate text-xs text-muted-foreground">{item.artist}</p>}
              </div>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{formatTrackLength(item.duration) ?? ''}</span>
            </li>
          ))}
        </ol>
      )}
      {state && count > items.length && (
        <p className="text-xs text-muted-foreground">Showing {items.length} of {count}.</p>
      )}
    </section>
  );
}

function Library({ canAdd, expire, refresh }: { canAdd: boolean; expire(error: unknown): boolean; refresh(): Promise<void> }) {
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
    <section aria-labelledby="library" className="space-y-2">
      <h2 id="library" className="text-sm font-semibold">Library</h2>
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
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      {loading && !library ? (
        <p role="status" className="text-sm text-muted-foreground">Searching the library…</p>
      ) : songs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{page > 1 ? 'No more songs.' : 'No songs found.'}</p>
      ) : (
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
      )}
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
  );
}

function UrlRequest({ expire, refresh }: { expire(error: unknown): boolean; refresh(): Promise<void> }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  const submit = () => {
    const problem = remoteMediaUrlError(url);
    if (problem) { setError(problem); setNotice(null); return; }
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    void enqueueRemoteMutation(() => requestRemoteUrl(url)).then(
      async () => {
        if (!remoteSession()) return;
        setUrl('');
        setNotice('Added the link to the queue.');
        await refresh();
      },
      (err: unknown) => { if (!expire(err)) setError(remoteErrorMessage(err)); },
    ).finally(() => { lock.current = false; setBusy(false); });
  };

  return (
    <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <Label htmlFor="remote-url">Media URL</Label>
      <Input
        id="remote-url"
        type="url"
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        enterKeyHint="done"
        maxLength={2048}
        placeholder="https://"
        value={url}
        className="h-11"
        onChange={(event) => setUrl(event.target.value)}
      />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      <Button type="submit" className="h-11 w-full sm:w-auto" disabled={busy || url.trim().length === 0}>
        {busy ? 'Adding…' : 'Request URL'}
      </Button>
    </form>
  );
}
