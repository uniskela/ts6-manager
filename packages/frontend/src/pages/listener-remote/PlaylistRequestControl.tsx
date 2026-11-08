import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  enqueueRemoteMutation,
  remotePlaylistRequestErrorMessage,
  remoteSession,
  requestRemotePlaylist,
  type RemotePlaylist,
  type RemotePlaylistRequestSettings,
  type RemoteVote,
} from '@/lib/listener-remote';
import { StatusNote } from './StatusNote';

export type PlaylistRequestAccess = {
  /** `permissions.requestPlaylist` from `/state`. */
  readonly allowed: boolean;
  readonly settings: RemotePlaylistRequestSettings | null;
  /** A vote is open on this bot and channel. */
  readonly voteOpen: boolean;
};

function songs(n: number): string {
  return `${n} song${n === 1 ? '' : 's'}`;
}

/**
 * Request a whole playlist: queued at once when voting is off (or the listener
 * is alone), otherwise a vote opens. Explains every reason it cannot be used.
 */
export function PlaylistRequestControl({ playlist, access, expire, refresh, onVote }: {
  readonly playlist: RemotePlaylist;
  readonly access: PlaylistRequestAccess;
  readonly expire: (error: unknown) => boolean;
  readonly refresh: () => Promise<void>;
  readonly onVote: (vote: RemoteVote) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // After a direct queue, a stray second tap must not queue the playlist again.
  const [queued, setQueued] = useState(false);
  const lock = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const hintId = useId();

  useLayoutEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
    else if (notice) noticeRef.current?.focus({ preventScroll: true });
  }, [error, notice]);

  if (!playlist.wholeRequest) {
    return <p className="text-sm text-foreground/80">You can add songs from this playlist one at a time. The whole playlist cannot be requested.</p>;
  }
  if (!access.allowed) {
    return <p className="text-sm text-foreground/80">You can add songs one at a time. Requesting the whole playlist is not allowed for you.</p>;
  }

  const { settings } = access;
  const max = settings?.maxTracks ?? null;
  const tooLarge = max !== null && playlist.trackCount > max;
  const empty = playlist.trackCount === 0;
  const voting = settings?.voting === true;
  const disabled = busy || queued || tooLarge || empty || access.voteOpen;

  let hint: string;
  if (empty) hint = 'This playlist has no songs that can be played here.';
  else if (tooLarge) hint = `Whole-playlist requests are limited to ${songs(max)}. This playlist has ${playlist.trackCount}.`;
  else if (access.voteOpen) hint = 'A playlist vote is running. Wait for it to finish before requesting another playlist.';
  else if (voting && settings) {
    hint = `Starts a ${settings.windowSeconds}-second vote in the channel. Your yes counts, and it passes when `
      + `${settings.thresholdPercent}% of listeners vote yes. If you are the only listener, it is added straight away.`;
  } else hint = `Adds all ${songs(playlist.trackCount)} to the queue.`;

  const label = voting ? 'Propose this playlist' : `Add all ${songs(playlist.trackCount)}`;

  const request = () => {
    if (disabled || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    void enqueueRemoteMutation(() => requestRemotePlaylist(playlist.id)).then(
      async (result) => {
        if (!remoteSession()) return;
        if (result.outcome === 'queued') {
          setQueued(true);
          setNotice(`Added ${songs(result.trackCount)} from “${playlist.name}” to the queue.`);
        } else {
          // The banner takes focus and announces the vote; no second message here.
          onVote(result.vote);
        }
        await refresh();
      },
      (err: unknown) => {
        if (expire(err)) return;
        setError(remotePlaylistRequestErrorMessage(err));
        void refresh();
      },
    ).finally(() => {
      lock.current = false;
      setBusy(false);
    });
  };

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <p id={hintId} className="text-sm text-foreground/80">{hint}</p>
      <Button
        type="button"
        className="h-11 min-h-11 w-full sm:w-auto"
        aria-describedby={hintId}
        disabled={disabled}
        onClick={request}
      >
        {busy ? 'Sending…' : queued ? 'Added to the queue' : label}
      </Button>
      {error && (
        <p ref={errorRef} role="alert" tabIndex={-1} className="text-sm text-destructive outline-none">{error}</p>
      )}
      {notice && (
        <p ref={noticeRef} tabIndex={-1} className="outline-none"><StatusNote>{notice}</StatusNote></p>
      )}
    </div>
  );
}
