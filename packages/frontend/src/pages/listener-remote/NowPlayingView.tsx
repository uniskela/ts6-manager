import { Music } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { playbackSummary, type RemoteState } from '@/lib/listener-remote';
import { StatusNote } from './StatusNote';

export function NowPlayingView({ state, loading, error }: {
  readonly state: RemoteState | null;
  readonly loading: boolean;
  readonly error: string | null;
}) {
  const track = state?.nowPlaying ?? null;
  const summary = playbackSummary(track, state?.bot.status ?? 'connected');
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <h2 id="now-playing" className="text-base font-semibold">Now playing</h2>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <NowPlayingBody state={state} loading={loading} error={error} track={track} summary={summary} />
      </CardContent>
    </Card>
  );
}

function NowPlayingBody({ state, loading, error, track, summary }: {
  readonly state: RemoteState | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly track: RemoteState['nowPlaying'];
  readonly summary: ReturnType<typeof playbackSummary>;
}) {
  if (loading && !state) return <StatusNote>Loading the remote…</StatusNote>;
  if (!track) {
    if (state || !error) return <p className="text-sm text-foreground/80">Nothing is playing.</p>;
    return null;
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Music className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-base font-semibold" title={track.title}>{track.title}</p>
          {track.artist && (
            <p className="truncate text-sm text-foreground/80" title={track.artist}>{track.artist}</p>
          )}
        </div>
      </div>
      <progress
        className={`h-1.5 w-full ${summary.playing ? 'animate-pulse accent-primary' : ''}`}
        aria-label="Playback progress"
        aria-valuetext={summary.label}
      />
      <div className="flex justify-between font-mono text-xs tabular-nums text-foreground/75">
        <span>{summary.state}</span>
        <span>{summary.length ?? 'Live'}</span>
      </div>
    </div>
  );
}
