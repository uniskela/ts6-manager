import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  REMOTE_POLL_MS,
  RemoteHttpError,
  canBrowseRemotePlaylists,
  canRequestRemotePlaylist,
  canSearchRemoteMusic,
  canVoteRemote,
  formatRemoteExpiry,
  loadRemoteState,
  remoteErrorMessage,
  remoteSession,
  shouldPollRemote,
  signOutRemote,
  type RemoteState,
  type RemoteVote,
} from '@/lib/listener-remote';
import { LibraryView } from './LibraryView';
import { NowPlayingView } from './NowPlayingView';
import { PlaylistsView } from './PlaylistsView';
import { SearchView } from './SearchView';
import { UpNextView } from './UpNextView';
import { UrlRequestView } from './UrlRequestView';
import { VoteBanner } from './VoteBanner';

const STATUS_LABEL: Record<string, string> = { playing: 'Playing', paused: 'Paused', connected: 'Connected' };

export function ReadyView({ onEnded }: { readonly onEnded: (message: string) => void }) {
  const [state, setState] = useState<RemoteState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  const lastPoll = useRef(0);
  const loadRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const bannerRef = useRef<HTMLElement>(null);
  const [focusVote, setFocusVote] = useState<string | null>(null);
  // The vote this listener proposed from here; its start is not announced, because focus moves to it.
  const [proposedVote, setProposedVote] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Bumped whenever a ballot, cancel or proposal answer is shown. A poll that started
  // before that answer carries an older vote, so its vote is not applied.
  const voteAnswers = useRef(0);
  const session = remoteSession();

  const loadState = async (force = false) => {
    const visible = document.visibilityState === 'visible';
    if (!force && !shouldPollRemote(visible, lastPoll.current, Date.now())) return;
    if (!remoteSession()) {
      onEnded('Remote access is invalid or expired');
      return;
    }
    lastPoll.current = Date.now();
    const answersAtStart = voteAnswers.current;
    try {
      const next = await loadRemoteState();
      if (!remoteSession()) return;
      const stale = answersAtStart !== voteAnswers.current;
      setState((prev) => (stale && prev ? { ...next, vote: prev.vote } : next));
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

  const refresh = useCallback(() => loadRef.current(true), []);
  // Show a vote from a mutation at once instead of waiting for the next poll.
  // `null` (a cancel answer) only marks that an answer arrived.
  const applyVote = useCallback((vote: RemoteVote | null) => {
    voteAnswers.current += 1;
    if (vote) setState((prev) => (prev ? { ...prev, vote } : prev));
  }, []);
  // One live region, mounted with the remote, so phone screen readers hear the first message.
  // Repeating the same text adds an invisible space so it is announced again.
  const announce = useCallback((message: string) => {
    setAnnouncement((prev) => (prev === message ? `${message}\u00a0` : message));
  }, []);
  const focusHeading = useCallback(() => headingRef.current?.focus({ preventScroll: true }), []);
  // A listener who just proposed a playlist is taken to the vote it opened.
  const openedVote = useCallback((vote: RemoteVote) => {
    applyVote(vote);
    setProposedVote(vote.id);
    setFocusVote(vote.id);
  }, [applyVote]);

  useLayoutEffect(() => {
    if (!focusVote || state?.vote?.id !== focusVote) return;
    setFocusVote(null);
    bannerRef.current?.focus({ preventScroll: true });
    bannerRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focusVote, state?.vote?.id]);

  const vote = state?.vote ?? null;

  return (
    <div className="space-y-4 lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start lg:gap-x-8 lg:gap-y-6 lg:space-y-0">
      <p data-testid="remote-announcer" className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      <header className="flex items-start justify-between gap-3 lg:col-span-2">
        <div className="min-w-0">
          <p className="text-xs text-foreground/75">Listener remote</p>
          <h1 ref={headingRef} tabIndex={-1} className="truncate text-lg font-semibold outline-none lg:text-2xl" title={state?.bot.name ?? 'Listener remote'}>
            {state?.bot.name ?? 'Listener remote'}
          </h1>
          {session && (
            <p className="mt-1 text-xs text-muted-foreground">
              {formatRemoteExpiry(session.expiresAt)}
              {session.remember ? ' · remembered browser' : ''}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {state && (
            <Badge variant={state.bot.status === 'playing' ? 'default' : 'secondary'}>
              {STATUS_LABEL[state.bot.status] ?? 'Connected'}
            </Badge>
          )}
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
            disabled={signingOut}
            onClick={() => {
              setSigningOut(true);
              void signOutRemote().then(
                () => onEnded('Signed out'),
                (error: unknown) => {
                  setSigningOut(false);
                  onEnded(remoteErrorMessage(error));
                },
              );
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {state && vote && (
        <VoteBanner
          vote={vote}
          windowSeconds={state.playlistRequests?.windowSeconds ?? 60}
          canVote={canVoteRemote(state.permissions)}
          quietStart={proposedVote === vote.id}
          expire={expire}
          refresh={refresh}
          applyVote={applyVote}
          announce={announce}
          focusFallback={focusHeading}
          bannerRef={bannerRef}
        />
      )}

      <div className="min-w-0 space-y-4 lg:sticky lg:top-6">
        <NowPlayingView state={state} loading={loadingState} error={stateError} />
        <UpNextView state={state} loading={loadingState} />
      </div>
      <div className="min-w-0 space-y-4">
        {state?.permissions.requestUrl && <UrlRequestView expire={expire} refresh={() => loadRef.current(true)} />}
        {state && canSearchRemoteMusic(state.permissions) && (
          <SearchView expire={expire} refresh={() => loadRef.current(true)} />
        )}
        {state?.permissions.searchLibrary && (
          <LibraryView canAdd={state.permissions.addToQueue} expire={expire} refresh={() => loadRef.current(true)} />
        )}
        {state && canBrowseRemotePlaylists(state.permissions) && (
          <PlaylistsView
            canAdd={state.permissions.addToQueue}
            request={{
              allowed: canRequestRemotePlaylist(state.permissions),
              settings: state.playlistRequests,
              voteOpen: vote?.status === 'open',
            }}
            expire={expire}
            refresh={refresh}
            onVote={openedVote}
          />
        )}
      </div>
    </div>
  );
}
