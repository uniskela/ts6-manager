import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import {
  cancelRemoteVote,
  castRemoteBallot,
  enqueueRemoteMutation,
  remoteSession,
  remoteVoteErrorMessage,
  voteCountsText,
  voteResultMessage,
  voteSecondsLeft,
  withdrawRemoteBallot,
  type RemoteBallot,
  type RemoteVote,
} from '@/lib/listener-remote';

/** Announce the countdown once, when this many seconds (or fewer) are left. */
const LAST_CALL_SECONDS = 10;

function secondsText(n: number): string {
  return `${n} second${n === 1 ? '' : 's'}`;
}

/**
 * The playlist vote on this bot and channel: what is proposed, the tally,
 * time left, and the listener's own ballot. Counts only, never who voted.
 * Every decision (tally, result, permissions) comes from the server.
 */
export function VoteBanner({
  vote,
  windowSeconds,
  canVote,
  quietStart,
  expire,
  refresh,
  applyVote,
  announce,
  focusFallback,
  bannerRef,
}: {
  readonly vote: RemoteVote;
  readonly windowSeconds: number;
  readonly canVote: boolean;
  /** This listener just proposed the vote and focus is moving to the banner: skip the start announcement. */
  readonly quietStart: boolean;
  readonly expire: (error: unknown) => boolean;
  readonly refresh: () => Promise<void>;
  /** Show a vote from a mutation answer; `null` only marks that an answer arrived (cancel). */
  readonly applyVote: (vote: RemoteVote | null) => void;
  /** Polite message in the remote's always-mounted live region. */
  readonly announce: (message: string) => void;
  /** Where focus goes if the banner disappears while it holds focus. */
  readonly focusFallback: () => void;
  readonly bannerRef: RefObject<HTMLElement>;
}) {
  const headingId = useId();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const closingRefresh = useRef<string | null>(null);
  const lastCall = useRef<string | null>(null);
  const seen = useRef<{ id: string; status: string } | null>(null);
  // act() already spoke this closed id/status; skip the effect so ReadyView's NBSP re-fire is not spoken twice.
  const resultAnnounced = useRef<{ id: string; status: string } | null>(null);
  // True while keyboard or screen-reader focus is somewhere in the banner.
  const focusInside = useRef(false);
  const open = vote.status === 'open';
  const secondsLeft = voteSecondsLeft(vote, now, windowSeconds);
  const name = `“${vote.playlist.name}”`;

  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [open, vote.id]);

  // At zero the server settles the vote on the next read: ask once instead of waiting for the poll.
  // The countdown itself decides nothing.
  useEffect(() => {
    if (!open || secondsLeft > 0 || closingRefresh.current === vote.id) return;
    closingRefresh.current = vote.id;
    void refresh();
  }, [open, secondsLeft, vote.id, refresh]);

  // Announce a new vote and a result. The visible countdown is a timer, which
  // screen readers do not read out every second.
  useEffect(() => {
    const before = seen.current;
    seen.current = { id: vote.id, status: vote.status };
    if (before?.id === vote.id && before.status === vote.status) return;
    if (!open) {
      if (resultAnnounced.current?.id === vote.id && resultAnnounced.current.status === vote.status) return;
      resultAnnounced.current = { id: vote.id, status: vote.status };
      announce(voteResultMessage(vote));
      return;
    }
    if (before?.id === vote.id) return;
    if (secondsLeft <= LAST_CALL_SECONDS) lastCall.current = vote.id;
    if (quietStart) return;
    const left = secondsText(secondsLeft);
    if (vote.isRequester) {
      announce(before === null
        ? `Your playlist vote for ${name} is running. ${left} left.`
        : `Your playlist vote started for ${name}. ${left} left.`);
    } else {
      announce(before === null
        ? `A playlist vote is running: play ${name}? ${left} left.`
        : `A playlist vote started: play ${name}? ${left} left.`);
    }
    // Only id and status changes are announced here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vote.id, vote.status]);

  // `<=` so a late timer tick (11 → 9) still gets the warning once.
  useEffect(() => {
    if (!open || secondsLeft > LAST_CALL_SECONDS || secondsLeft <= 0 || lastCall.current === vote.id) return;
    lastCall.current = vote.id;
    announce(`${secondsText(secondsLeft)} left to vote on ${name}.`);
  }, [open, secondsLeft, vote.id, name, announce]);

  useEffect(() => { setError(null); }, [vote.id]);

  useLayoutEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  // A tap or click outside the banner means the listener moved on: stop holding focus.
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!bannerRef.current?.contains(event.target as Node)) focusInside.current = false;
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [bannerRef]);

  // When the focused control disappears (withdraw, cancel, the vote closing, voting
  // turned off), the browser drops focus to the page. Keep it on the banner instead.
  useLayoutEffect(() => {
    if (!focusInside.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) {
      if (!bannerRef.current?.contains(active)) focusInside.current = false;
      return;
    }
    bannerRef.current?.focus({ preventScroll: true });
  });

  // The banner goes away about 30 s after a vote closes; don't strand focus with it.
  const fallbackRef = useRef(focusFallback);
  fallbackRef.current = focusFallback;
  useLayoutEffect(() => () => {
    if (focusInside.current) fallbackRef.current();
  }, []);

  const act = (
    task: () => Promise<RemoteVote | null>,
    done: (next: RemoteVote | null) => string,
    action: 'ballot' | 'cancel' = 'ballot',
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    void enqueueRemoteMutation(task).then(
      async (next) => {
        if (!remoteSession()) return;
        // Mark before applyVote so the status-change effect does not re-announce.
        if (next && next.status !== 'open') {
          resultAnnounced.current = { id: next.id, status: next.status };
        } else if (action === 'cancel') {
          resultAnnounced.current = { id: vote.id, status: 'cancelled' };
        }
        applyVote(next);
        announce(done(next));
        await refresh();
      },
      (err: unknown) => {
        if (expire(err)) return;
        setError(remoteVoteErrorMessage(err, action));
        void refresh();
      },
    ).finally(() => {
      lock.current = false;
      setBusy(false);
    });
  };

  const ballot = (choice: RemoteBallot) => {
    // Already chosen: a second tap changes nothing and sends nothing.
    if (vote.ownBallot === choice) return;
    act(
      () => castRemoteBallot(vote.id, choice),
      (next) => (next && next.status !== 'open' ? voteResultMessage(next) : `You voted ${choice}.`),
    );
  };
  const withdraw = () => act(() => withdrawRemoteBallot(vote.id), () => 'Your vote was removed.');
  const cancel = () => act(async () => { await cancelRemoteVote(vote.id); return null; }, () => 'You cancelled the vote.', 'cancel');

  const tone = open
    ? 'border-primary/70'
    : vote.status === 'passed' ? 'border-success/70' : 'border-muted-foreground/40';

  return (
    <section
      ref={bannerRef}
      tabIndex={-1}
      aria-labelledby={headingId}
      data-testid="vote-banner"
      onFocus={() => { focusInside.current = true; }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && !event.currentTarget.contains(next)) focusInside.current = false;
      }}
      className={`space-y-3 rounded-lg border-2 bg-card p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring lg:col-span-2 ${tone}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-base font-semibold">
          {open ? 'Playlist vote' : 'Playlist vote ended'}
        </h2>
        {open && (
          <p role="timer" className="text-sm tabular-nums text-foreground/80">
            {secondsLeft > 0 ? `${secondsText(secondsLeft)} left` : 'Counting votes…'}
          </p>
        )}
      </div>

      {open ? (
        <>
          <p className="break-words text-sm">
            Play <span className="font-medium">{name}</span> ({vote.playlist.trackCount} song{vote.playlist.trackCount === 1 ? '' : 's'})?
          </p>
          <TallyBar vote={vote} />
          <p className="text-sm text-foreground/80">{voteCountsText(vote)}</p>
          <OwnBallot vote={vote} canVote={canVote} />
          <VoteActions vote={vote} canVote={canVote} busy={busy} ballot={ballot} withdraw={withdraw} cancel={cancel} />
        </>
      ) : (
        <p data-testid="vote-result" className="break-words text-sm">{voteResultMessage(vote)}</p>
      )}

      {error && (
        <p ref={errorRef} role="alert" tabIndex={-1} className="text-sm text-destructive outline-none">{error}</p>
      )}
    </section>
  );
}

/** Yes votes against the number needed. Decorative: the same numbers are in the text. */
function TallyBar({ vote }: { readonly vote: RemoteVote }) {
  const needed = Math.max(vote.needed, 1);
  const width = Math.min(100, Math.round((vote.yes / needed) * 100));
  return (
    <div aria-hidden="true" className="h-2 w-full overflow-hidden rounded-full bg-muted">
      {/* React sets this through CSSOM, which the remote's CSP (style-src 'self') allows. */}
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${width}%` }} />
    </div>
  );
}

function OwnBallot({ vote, canVote }: { readonly vote: RemoteVote; readonly canVote: boolean }) {
  if (vote.isRequester) {
    return <p className="text-sm text-foreground/80">You proposed this playlist, so your yes is already counted.</p>;
  }
  if (!canVote) {
    return <p className="text-sm text-foreground/80">Voting is not available to you right now.</p>;
  }
  if (vote.ownBallot) return <p className="text-sm text-foreground/80">You voted {vote.ownBallot}. You can change your vote until it closes.</p>;
  return null;
}

// While a request runs the buttons are aria-disabled, not disabled, so a focused
// button keeps focus; the lock in `act` ignores extra taps.
const BUSY = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

function VoteActions({ vote, canVote, busy, ballot, withdraw, cancel }: {
  readonly vote: RemoteVote;
  readonly canVote: boolean;
  readonly busy: boolean;
  readonly ballot: (choice: RemoteBallot) => void;
  readonly withdraw: () => void;
  readonly cancel: () => void;
}) {
  const busyProps = { 'aria-disabled': busy || undefined };
  if (vote.isRequester) {
    return (
      <Button type="button" variant="outline" className={`h-11 min-h-11 w-full sm:w-auto ${BUSY}`} {...busyProps} onClick={cancel}>
        Cancel vote
      </Button>
    );
  }
  if (!canVote) return null;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      <div role="group" aria-label={`Vote on “${vote.playlist.name}”`} className="grid grid-cols-2 gap-2 sm:flex">
        <Button
          type="button"
          variant={vote.ownBallot === 'yes' ? 'default' : 'outline'}
          className={`h-11 min-h-11 sm:min-w-24 ${BUSY}`}
          aria-pressed={vote.ownBallot === 'yes'}
          {...busyProps}
          onClick={() => ballot('yes')}
        >
          Yes
        </Button>
        <Button
          type="button"
          variant={vote.ownBallot === 'no' ? 'default' : 'outline'}
          className={`h-11 min-h-11 sm:min-w-24 ${BUSY}`}
          aria-pressed={vote.ownBallot === 'no'}
          {...busyProps}
          onClick={() => ballot('no')}
        >
          No
        </Button>
      </div>
      {vote.ownBallot && (
        <Button type="button" variant="ghost" className={`h-11 min-h-11 ${BUSY}`} {...busyProps} onClick={withdraw}>
          Remove my vote
        </Button>
      )}
    </div>
  );
}
