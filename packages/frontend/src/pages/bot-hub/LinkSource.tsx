/**
 * Console Link tab: play a URL as music, or stream a URL / music-folder file
 * as video. Conflicts use the global "Replace what is playing?" dialog.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { VideoOptions } from '@/components/video/VideoOptions';
import { usePlayUrl, useStartVideoStream } from '@/hooks/use-music-bots';
import { useVideoStartOptions } from '@/hooks/use-video-streaming';
import { apiErrorMessage } from '@/lib/api-error';
import { toastMediaStarted } from '@/lib/media-start-toast';
import { cn } from '@/lib/utils';
import {
  buildLinkStartRequest,
  musicPlayAllowed,
  type LinkPlayMode,
} from './link-request';
import { AddMediaLink } from './AddMediaLink';
import type { ConsoleSourceContext } from './SourcePicker';

const LINK_LABEL = 'YouTube, Twitch, direct link, or a file already in the music folder';
const FOLDER_HINT = 'Music-folder files play from the Music tab.';

export function LinkSource({ botId, serverConfigId }: ConsoleSourceContext) {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<LinkPlayMode>('music');
  const [options, setOptions, optionsLoading, defaults] = useVideoStartOptions(serverConfigId);
  const playUrl = usePlayUrl();
  const startVideo = useStartVideoStream();

  const trimmed = input.trim();
  // Empty input keeps music selectable (default); only a non-URL value disables it.
  const allowMusic = !trimmed || musicPlayAllowed(input);
  const effectiveMode: LinkPlayMode = mode === 'music' && trimmed && !musicPlayAllowed(input) ? 'video' : mode;
  const busy = playUrl.isPending || startVideo.isPending;
  const error = effectiveMode === 'video' ? startVideo.error : playUrl.error;
  const canStart = trimmed.length > 0 && !busy && !(effectiveMode === 'video' && optionsLoading);

  useEffect(() => {
    if (trimmed && !musicPlayAllowed(input) && mode === 'music') setMode('video');
  }, [input, trimmed, mode]);

  useEffect(() => {
    if (mode === 'music') startVideo.reset();
    else playUrl.reset();
    // Clear the other mode's error when the user switches Play as music / Stream as video.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only on mode change
  }, [mode]);

  const onStart = () => {
    if (!canStart) return;
    const request = buildLinkStartRequest(input, effectiveMode, options);
    if (request.endpoint === 'play-url') {
      startVideo.reset();
      playUrl.mutate(
        { botId, url: request.body.url },
        { onSuccess: () => toastMediaStarted('Playing URL') },
      );
      return;
    }
    playUrl.reset();
    startVideo.mutate(
      { botId, ...request.body },
      { onSuccess: () => toastMediaStarted('Video stream started') },
    );
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="console-link-input">{LINK_LABEL}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="console-link-input"
            className="h-11 min-w-0 flex-1 basis-48"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://… or filename.mp4"
            autoComplete="off"
          />
          <AddMediaLink to="/media-bots" label="Add files" />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">How should the bot play it?</legend>
        <label
          className={cn(
            'flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 text-sm transition-colors',
            !allowMusic && 'cursor-not-allowed opacity-60',
            effectiveMode === 'music' && allowMusic ? 'border-primary bg-primary/5' : 'hover:bg-muted/40',
          )}
        >
          <input
            type="radio"
            name="console-link-mode"
            className="mt-0.5 h-4 w-4 shrink-0"
            value="music"
            checked={effectiveMode === 'music'}
            disabled={!allowMusic}
            aria-labelledby="console-link-music-label"
            aria-describedby="console-link-music-hint"
            onChange={() => setMode('music')}
          />
          <span className="min-w-0">
            <span id="console-link-music-label" className="block font-medium">Play as music</span>
            <span id="console-link-music-hint" className="block text-xs text-muted-foreground">Audio only, goes in the queue</span>
          </span>
        </label>
        {!allowMusic && input.trim() && (
          <p className="px-1 text-xs text-muted-foreground">{FOLDER_HINT}</p>
        )}
        <label
          className={cn(
            'flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 text-sm transition-colors',
            effectiveMode === 'video' ? 'border-primary bg-primary/5' : 'hover:bg-muted/40',
          )}
        >
          <input
            type="radio"
            name="console-link-mode"
            className="mt-0.5 h-4 w-4 shrink-0"
            value="video"
            checked={effectiveMode === 'video'}
            aria-labelledby="console-link-video-label"
            aria-describedby="console-link-video-hint"
            onChange={() => setMode('video')}
          />
          <span className="min-w-0">
            <span id="console-link-video-label" className="block font-medium">Stream as video</span>
            <span id="console-link-video-hint" className="block text-xs text-muted-foreground">Picture and sound in the channel</span>
          </span>
        </label>
      </fieldset>

      {effectiveMode === 'video' && (
        <VideoOptions value={options} onChange={setOptions} defaults={defaults} />
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {apiErrorMessage(error, effectiveMode === 'video' ? 'Failed to start stream' : 'Failed to play URL')}
        </p>
      )}

      <Button type="button" className="h-11 w-full sm:w-auto" disabled={!canStart} onClick={onStart}>
        {busy ? 'Starting…' : effectiveMode === 'video' ? 'Stream as video' : 'Play as music'}
      </Button>
    </div>
  );
}
