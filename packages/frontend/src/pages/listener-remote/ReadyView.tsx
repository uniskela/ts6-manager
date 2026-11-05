import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  REMOTE_POLL_MS,
  RemoteHttpError,
  loadRemoteState,
  remoteErrorMessage,
  remoteSession,
  shouldPollRemote,
  type RemoteState,
} from '@/lib/listener-remote';
import { LibraryView } from './LibraryView';
import { NowPlayingView } from './NowPlayingView';
import { UpNextView } from './UpNextView';
import { UrlRequestView } from './UrlRequestView';

const STATUS_LABEL: Record<string, string> = { playing: 'Playing', paused: 'Paused', connected: 'Connected' };

export function ReadyView({ onEnded }: { readonly onEnded: (message: string) => void }) {
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
    <div className="space-y-4 lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start lg:gap-x-8 lg:gap-y-6 lg:space-y-0">
      <header className="flex items-start justify-between gap-3 lg:col-span-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Listener remote</p>
          <h1 className="truncate text-lg font-semibold lg:text-2xl">{state?.bot.name ?? 'Listener remote'}</h1>
        </div>
        {state && (
          <Badge variant={state.bot.status === 'playing' ? 'default' : 'secondary'} className="shrink-0">
            {STATUS_LABEL[state.bot.status] ?? 'Connected'}
          </Badge>
        )}
      </header>

      <div className="min-w-0 space-y-4 lg:sticky lg:top-6">
        <NowPlayingView state={state} loading={loadingState} error={stateError} />
        <UpNextView state={state} loading={loadingState} />
      </div>
      <div className="min-w-0 space-y-4">
        {state?.permissions.requestUrl && <UrlRequestView expire={expire} refresh={() => loadRef.current(true)} />}
        {state?.permissions.searchLibrary && (
          <LibraryView canAdd={state.permissions.addToQueue} expire={expire} refresh={() => loadRef.current(true)} />
        )}
      </div>
    </div>
  );
}
