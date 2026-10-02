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
import { apiErrorMessage } from '@/lib/api-error';
import { toastMediaStarted } from '@/lib/media-start-toast';
import {
  DEFAULT_VIDEO_START_OPTIONS,
  type VideoStartOptions,
} from '@/lib/video-options';
import { cn } from '@/lib/utils';
import {
  buildLinkStartRequest,
  musicPlayAllowed,
  type LinkPlayMode,
} from './link-request';
import type { ConsoleSourceContext } from './SourcePicker';

const LINK_LABEL = 'YouTube, Twitch, direct link, or a file already in the music folder';
const FOLDER_HINT = 'Music-folder files play from the Music tab.';

export function LinkSource({ botId }: ConsoleSourceContext) {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<LinkPlayMode>('music');
  const [options, setOptions] = useState<VideoStartOptions>(DEFAULT_VIDEO_START_OPTIONS);
  const playUrl = usePlayUrl();
  const startVideo = useStartVideoStream();

  const allowMusic = musicPlayAllowed(input);
  const effectiveMode: LinkPlayMode = mode === 'music' && !allowMusic ? 'video' : mode;
  const busy = playUrl.isPending || startVideo.isPending;
  const error = playUrl.error ?? startVideo.error;
  const canStart = input.trim().length > 0 && !busy;

  useEffect(() => {
    if (!allowMusic && mode === 'music') setMode('video');
  }, [allowMusic, mode]);

  const onStart = () => {
    if (!canStart) return;
    const request = buildLinkStartRequest(input, effectiveMode, options);
    if (request.endpoint === 'play-url') {
      playUrl.mutate(
        { botId, url: request.body.url },
        { onSuccess: () => toastMediaStarted('Playing URL') },
      );
      return;
    }
    startVideo.mutate(
      { botId, ...request.body },
      { onSuccess: () => toastMediaStarted('Video stream started') },
    );
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="console-link-input">{LINK_LABEL}</Label>
        <Input
          id="console-link-input"
          className="h-11"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="https://… or filename.mp4"
          autoComplete="off"
        />
      </div>

      <div role="radiogroup" aria-label="How to play" className="space-y-1">
        <label
          className={cn(
            'flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 text-sm',
            !allowMusic && 'cursor-not-allowed opacity-60',
            effectiveMode === 'music' && allowMusic && 'border-primary bg-primary/5',
          )}
        >
          <input
            type="radio"
            name="console-link-mode"
            className="h-4 w-4 shrink-0"
            value="music"
            checked={effectiveMode === 'music'}
            disabled={!allowMusic}
            onChange={() => setMode('music')}
          />
          <span className="font-medium">Play as music</span>
        </label>
        {!allowMusic && input.trim() && (
          <p className="px-1 text-xs text-muted-foreground">{FOLDER_HINT}</p>
        )}
        <label
          className={cn(
            'flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 text-sm',
            effectiveMode === 'video' && 'border-primary bg-primary/5',
          )}
        >
          <input
            type="radio"
            name="console-link-mode"
            className="h-4 w-4 shrink-0"
            value="video"
            checked={effectiveMode === 'video'}
            onChange={() => setMode('video')}
          />
          <span className="font-medium">Stream as video</span>
        </label>
      </div>

      {effectiveMode === 'video' && (
        <VideoOptions value={options} onChange={setOptions} />
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {apiErrorMessage(error, effectiveMode === 'video' ? 'Failed to start stream' : 'Failed to play URL')}
        </p>
      )}

      <Button type="button" className="h-11 w-full sm:w-auto" disabled={!canStart} onClick={onStart}>
        {busy ? 'Starting…' : effectiveMode === 'video' ? 'Stream' : 'Play'}
      </Button>
    </div>
  );
}
