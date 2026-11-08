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

/** Announce the countdown once, when this many seconds are left. */
const LAST_CALL_SECONDS = 10;

/**
 * The playlist vote on this bot and channel: what is proposed, the tally,
 * time left, and the listener's own ballot. Counts only, never who voted.
 */
export function VoteBanner({ vote, windowSeconds, canVote, expire, refresh, applyVote, bannerRef }: {
  readonly vote: RemoteVote;
  readonly windowSeconds: number;
  readonly canVote: boolean;
  readonly expire: (error: unknown) => boolean;
  readonly refresh: () => Promise<void>;
  readonly applyVote: (vote: RemoteVote) => void;
  readonly bannerRef: RefObject<HTMLElement>;
}) {
  const headingId = useId();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const lock = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const closingRefresh = useRef<string | null>(null);
  const lastCall = useRef<string | null>(null);
  const seen = useRef<{ id: string; status: string } | null>(null);
  const open = vote.status === 'open';
  const secondsLeft = voteSecondsLeft(vote, now, windowSeconds);
  const name = `“${vote.playlist.name}”`;

  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [open, vote.id]);

  // At zero the server settles the vote on the next read: ask once instead of waiting for the poll.
  useEffect(() => {
    if (!open || secondsLeft > 0 || closingRefresh.current === vote.id) return;
    closingRefresh.current = vote.id;
    void refresh();
  }, [open, secondsLeft, vote.id, refresh]);

  // Polite announcements for a new vote, a result, and the last ten seconds. The visible
  // countdown is a timer, which screen readers do not read out every second.
  useEffect(() => {
    const before = seen.current;
    seen.current = { id: vote.id, status: vote.status };
    if (before?.id === vote.id && before.status === vote.status) return;
    if (open) {
      setAnnouncement(vote.isRequester
        ? `Your playlist vote started for ${name}. ${secondsLeft} seconds left.`
        : `A playlist vote started: play ${name}? ${secondsLeft} seconds left.`);
    } else {
      setAnnouncement(voteResultMessage(vote));
    }
    // Only the id and status changes are announced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vote.id, vote.status]);

  useEffect(() => {
    if (!open || secondsLeft !== LAST_CALL_SECONDS || lastCall.current === vote.id) return;
    lastCall.current = vote.id;
    setAnnouncement(`${LAST_CALL_SECONDS} seconds left to vote on ${name}.`);
  }, [open, secondsLeft, vote.id, name]);

  useEffect(() => { setError(null); }, [vote.id]);

  useLayoutEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  const act = (task: () => Promise<RemoteVote | null>, done: (next: RemoteVote | null) => string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    void enqueueRemoteMutation(task).then(
      async (next) => {
        if (!remoteSession()) return;
        if (next) applyVote(next);
        setAnnouncement(done(next));
        await refresh();
      },
      (err: unknown) => {
        if (expire(err)) return;
        setError(remoteVoteErrorMessage(err));
        void refresh();
      },
    ).finally(() => {
      lock.current = false;
      setBusy(false);
    });
  };

  const ballot = (choice: RemoteBallot) => act(
    () => castRemoteBallot(vote.id, choice),
    (next) => (next && next.status !== 'open' ? voteResultMessage(next) : `You voted ${choice}.`),
  );
  const withdraw = () => act(() => withdrawRemoteBallot(vote.id), () => 'Your vote was withdrawn.');
  const cancel = () => act(async () => { await cancelRemoteVote(vote.id); return null; }, () => 'You cancelled the vote.');

  const tone = open
    ? 'border-primary/70'
    : vote.status === 'passed' ? 'border-success/70' : 'border-muted-foreground/40';

  return (
    <section
      ref={bannerRef}
      tabIndex={-1}
      aria-labelledby={headingId}
      data-testid="vote-banner"
      className={`space-y-3 rounded-lg border-2 bg-card p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring lg:col-span-2 ${tone}`}
    >
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-base font-semibold">
          {open ? 'Playlist vote' : 'Playlist vote ended'}
        </h2>
        {open && (
          <p role="timer" className="font-mono text-sm tabular-nums text-foreground/80">
            {secondsLeft > 0 ? `${secondsLeft} s left` : 'Closing…'}
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
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${width}%` }} />
    </div>
  );
}

function OwnBallot({ vote, canVote }: { readonly vote: RemoteVote; readonly canVote: boolean }) {
  if (vote.isRequester) {
    return <p className="text-sm text-foreground/80">You proposed this playlist, so your yes is already counted.</p>;
  }
  if (!canVote) {
    return <p className="text-sm text-foreground/80">Only listeners in the bot's channel can vote.</p>;
  }
  if (vote.ownBallot) return <p className="text-sm text-foreground/80">You voted {vote.ownBallot}. You can change your vote until it closes.</p>;
  return null;
}

function VoteActions({ vote, canVote, busy, ballot, withdraw, cancel }: {
  readonly vote: RemoteVote;
  readonly canVote: boolean;
  readonly busy: boolean;
  readonly ballot: (choice: RemoteBallot) => void;
  readonly withdraw: () => void;
  readonly cancel: () => void;
}) {
  if (vote.isRequester) {
    return (
      <Button type="button" variant="outline" className="h-11 min-h-11 w-full sm:w-auto" disabled={busy} onClick={cancel}>
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
          className="h-11 min-h-11 sm:min-w-24"
          aria-pressed={vote.ownBallot === 'yes'}
          disabled={busy}
          onClick={() => ballot('yes')}
        >
          Yes
        </Button>
        <Button
          type="button"
          variant={vote.ownBallot === 'no' ? 'default' : 'outline'}
          className="h-11 min-h-11 sm:min-w-24"
          aria-pressed={vote.ownBallot === 'no'}
          disabled={busy}
          onClick={() => ballot('no')}
        >
          No
        </Button>
      </div>
      {vote.ownBallot && (
        <Button type="button" variant="ghost" className="h-11 min-h-11" disabled={busy} onClick={withdraw}>
          Withdraw my vote
        </Button>
      )}
    </div>
  );
}
