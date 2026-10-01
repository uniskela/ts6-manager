/**
 * Video Stream Tab — embedded in the MusicBots page.
 * Controls video streaming: live preview, source / quality / encoder,
 * start/stop, and viewer management.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { VideoEncoderRequest, VideoQualityRequest, VideoSourceModeRequest } from '@ts6/common';
import { VideoPlayer } from './VideoPlayer';
import { VideoStreamDefaultsCard } from './VideoStreamDefaultsCard';
import {
  useVideoStreamStatus,
  useStartVideoStream,
  useStopVideoStream,
  useSetStreamSource,
  useSetStreamVolume,
  useKickVideoViewer,
} from '@/hooks/use-music-bots';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RuntimeMediaDiagnostics } from '@/components/media/RuntimeMediaDiagnostics';
import { useServerVideoStreamingSettings, useVideoStreamingSettings } from '@/hooks/use-video-streaming';
import { useAuthStore } from '@/stores/auth.store';
import {
  ENCODER_LABELS,
  ENCODER_OPTIONS,
  NO_VIEWER_TIMEOUT_OPTIONS,
  QUALITY_OPTIONS,
  SOURCE_MODE_LABELS,
  SOURCE_MODE_OPTIONS,
  healthLabel,
  encoderLabel,
  formatClock,
  formatTimeout,
  lastStopLabel,
  qualityLabel,
} from '@/lib/video-streaming';
import { apiErrorMessage } from '@/lib/api-error';
import { toastMediaStarted } from '@/lib/media-start-toast';
import { toast } from 'sonner';

/** Current time: every second while live (countdown, uptime), every 30s otherwise ("8 min ago"). */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), live ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

const FPS_OPTIONS = [
  { value: '24', label: '24 FPS' },
  { value: '30', label: '30 FPS' },
  { value: '60', label: '60 FPS' },
];

interface VideoStreamTabProps {
  botId: number;
  botStatus: string;
  /** The bot's server: its effective defaults are shown, and admins can override them. */
  server?: { id: number; name: string } | null;
}

export function VideoStreamTab({ botId, botStatus, server }: VideoStreamTabProps) {
  const [sourceUrl, setSourceUrl] = useState('');
  const [preset, setPreset] = useState<VideoQualityRequest>('auto');
  const [encoder, setEncoder] = useState<'default' | VideoEncoderRequest>('default');
  const [noViewerTimeout, setNoViewerTimeout] = useState('default');
  const [sourceMode, setSourceMode] = useState<VideoSourceModeRequest>('auto');
  const [framerate, setFramerate] = useState('30');
  const [bitrate, setBitrate] = useState('');
  const [streamVolume, setStreamVolume] = useState(100);

  const isAdmin = useAuthStore((state) => state.isAdmin());
  const { data: globalDefaults } = useVideoStreamingSettings();
  const { data: serverDefaults } = useServerVideoStreamingSettings(server?.id);
  const defaults = serverDefaults?.effective ?? globalDefaults;
  const { data: streamStatus } = useVideoStreamStatus(botId);
  const startStream = useStartVideoStream();
  const stopStream = useStopVideoStream();
  const setSource = useSetStreamSource();
  const setStreamVolumeMut = useSetStreamVolume();
  const kickViewer = useKickVideoViewer();

  const isStreaming = streamStatus?.streaming ?? false;
  const isBotConnected = botStatus === 'connected' || botStatus === 'playing' || botStatus === 'paused';
  const now = useNow(isStreaming);

  const handleStart = () => {
    if (!sourceUrl.trim()) return;
    startStream.mutate(
      {
        botId,
        source: sourceUrl.trim(),
        preset,
        encoder: encoder === 'default' ? undefined : encoder,
        noViewerTimeoutSec: noViewerTimeout === 'default' ? undefined : Number(noViewerTimeout),
        sourceMode,
        framerate: Number(framerate),
        bitrate: bitrate.trim() || undefined,
        volume: streamVolume,
      },
      {
        onSuccess: () => toastMediaStarted('Video stream started'),
        onError: (err) => toast.error(apiErrorMessage(err, 'Failed to start stream')),
      },
    );
  };

  const handleStop = () => {
    stopStream.mutate(botId);
  };

  const handleChangeSource = () => {
    if (!sourceUrl.trim()) return;
    setSource.mutate({ botId, source: sourceUrl.trim() });
  };

  const defaultEncoderLabel = defaults
    ? (defaults.defaultEncoder === 'auto'
      ? `Auto${defaults.preferHardware ? ', prefer hardware' : ''}`
      : ENCODER_LABELS[defaults.defaultEncoder])
    : '…';
  const selectedQuality = QUALITY_OPTIONS.find((q) => q.value === preset);
  const stopAt = streamStatus?.noViewer?.stopAt ?? null;
  const lastStop = lastStopLabel(streamStatus?.lastStop, now);

  return (
    <div className="space-y-4">
      {/* Preview + compact diagnostics */}
      {isBotConnected && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(200px,260px)] lg:items-start">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">Live Preview</CardTitle>
                {isStreaming && (
                  <Badge variant="destructive" className="gap-1">
                    <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                    LIVE
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <VideoPlayer
                botId={botId}
                streaming={isStreaming}
                idleDetail={!isStreaming && lastStop ? `Last stream: ${lastStop}` : null}
              />
              {isStreaming && streamStatus && (
                <div className="mt-3 space-y-2">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
                    <div>
                      <dt className="text-muted-foreground">Quality</dt>
                      <dd className="font-medium">
                        {qualityLabel(streamStatus.quality, streamStatus.preset)}
                        {!!streamStatus.quality?.sourceWidth && !!streamStatus.quality.sourceHeight && (
                          <span className="font-normal text-muted-foreground">
                            {' '}(source {streamStatus.quality.sourceWidth}×{streamStatus.quality.sourceHeight})
                          </span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Encoder</dt>
                      <dd className="font-medium">{encoderLabel(streamStatus.encoder)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">FPS · Bitrate</dt>
                      <dd className="font-medium">{streamStatus.framerate} · {streamStatus.bitrate}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Source · Encode</dt>
                      <dd className={streamStatus.health?.belowRealtime ? 'font-medium text-warning' : 'font-medium'}>
                        {streamStatus.sourceMode ? SOURCE_MODE_LABELS[streamStatus.sourceMode] : '—'} · {healthLabel(streamStatus.health)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Viewers</dt>
                      <dd className="font-medium">{streamStatus.viewerCount}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Uptime</dt>
                      <dd className="font-medium">
                        {streamStatus.startedAt ? formatClock(now - streamStatus.startedAt) : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">No-viewer stop</dt>
                      <dd className={stopAt ? 'font-medium text-warning' : 'font-medium'}>
                        {stopAt
                          ? `Auto-stop in ${formatClock(stopAt - now)}`
                          : streamStatus.noViewer?.timeoutSec
                            ? `After ${formatTimeout(streamStatus.noViewer.timeoutSec)} idle`
                            : 'Off'}
                      </dd>
                    </div>
                  </dl>
                  {streamStatus.health?.warning && (
                    <p role="status" className="flex items-start gap-1.5 text-xs text-warning">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>{streamStatus.health.warning}</span>
                    </p>
                  )}
                  {streamStatus.encoder?.fallbackReason && (
                    <p role="status" className="flex items-start gap-1.5 text-xs text-warning">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>Hardware encoder fell back to software: {streamStatus.encoder.fallbackReason}</span>
                    </p>
                  )}
                  {[streamStatus.encoder?.note, streamStatus.quality?.note].filter(Boolean).map((note) => (
                    <p key={note} className="text-xs text-muted-foreground">{note}</p>
                  ))}
                  {streamStatus.source && (
                    <p className="truncate text-xs text-muted-foreground">
                      Source: <strong>{streamStatus.source}</strong>
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <RuntimeMediaDiagnostics
            className="lg:sticky lg:top-4"
            focus={['sidecar', 'ffmpeg', 'ffprobe', 'yt-dlp']}
            showPrerequisite
            compact
            stageColumns={2}
          />
        </div>
      )}

      {!isBotConnected && (
        <RuntimeMediaDiagnostics
          className="max-w-md"
          focus={['sidecar', 'ffmpeg', 'ffprobe', 'yt-dlp']}
          showPrerequisite
          compact
          stageColumns={2}
        />
      )}

      {/* Stream Controls */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Stream</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isBotConnected && (
            <p className="text-sm text-muted-foreground">
              Bot must be connected to start video streaming.
            </p>
          )}

          {isBotConnected && (
            <>
              <div className="space-y-2">
                <Label>Source URL</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="https://youtube.com/watch?v=... or direct video URL"
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                    disabled={startStream.isPending}
                  />
                  {isStreaming ? (
                    <Button
                      onClick={handleChangeSource}
                      disabled={!sourceUrl.trim() || setSource.isPending}
                      variant="outline"
                      className="shrink-0"
                    >
                      Switch
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  YouTube / Twitch URLs, direct http(s) video URLs, or a filename already under the music directory
                </p>
              </div>

              {!isStreaming && (
                <div className="grid gap-6 sm:grid-cols-2">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Quality</Label>
                      <div className="flex flex-wrap gap-2">
                        {QUALITY_OPTIONS.map((p) => (
                          <Button
                            key={p.value}
                            variant={preset === p.value ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setPreset(p.value)}
                            title={p.hint}
                          >
                            {p.label}
                          </Button>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {preset === 'auto'
                          ? `Matches the source resolution up to ${defaults?.autoMaxPreset ?? '1080p'} and never upscales (probes the source first).`
                          : `${selectedQuality?.hint ?? ''} — fixed presets skip the source probe.`}
                        {(preset === '1440p' || preset === '2160p') && ' High presets need a fast CPU or a hardware encoder.'}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Source type</Label>
                      <div className="flex flex-wrap gap-2">
                        {SOURCE_MODE_OPTIONS.map((o) => (
                          <Button
                            key={o.value}
                            variant={sourceMode === o.value ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setSourceMode(o.value)}
                          >
                            {o.label}
                          </Button>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Live sources never loop or &quot;end&quot;; Detect uses the Auto-quality probe (fixed presets treat URLs as on demand). Local files are always files.
                      </p>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="stream-encoder">Encoder</Label>
                      <Select value={encoder} onValueChange={(v) => setEncoder(v as typeof encoder)}>
                        <SelectTrigger id="stream-encoder"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Default ({defaultEncoderLabel})</SelectItem>
                          {ENCODER_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Hardware encoders fall back to software (same codec) if the GPU cannot run them.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="stream-no-viewer">Stop when nobody watches</Label>
                      <Select value={noViewerTimeout} onValueChange={setNoViewerTimeout}>
                        <SelectTrigger id="stream-no-viewer"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {NO_VIEWER_TIMEOUT_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.value === 'default' && defaults
                                ? `Default (${formatTimeout(defaults.noViewerTimeoutSec)})`
                                : o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        This stream only; the saved default is unchanged.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Frame Rate (FPS)</Label>
                      <div className="flex gap-2">
                        {FPS_OPTIONS.map((fps) => (
                          <Button
                            key={fps.value}
                            variant={framerate === fps.value ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setFramerate(fps.value)}
                          >
                            {fps.label}
                          </Button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Video Bitrate</Label>
                      <Input
                        value={bitrate}
                        onChange={(e) => setBitrate(e.target.value)}
                        placeholder="Preset default"
                      />
                      <p className="text-xs text-muted-foreground">
                        Leave empty for the preset&apos;s bitrate, or e.g. 2500k, 6000k.
                        {defaults && defaults.maxBitrateKbps > 0 && ` Limited to ${defaults.maxBitrateKbps}k.`}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Stream Volume ({streamVolume}%)</Label>
                      <Slider
                        value={[streamVolume]}
                        min={0}
                        max={100}
                        step={1}
                        onValueChange={([val]) => {
                          setStreamVolume(val);
                          if (isStreaming) {
                            setStreamVolumeMut.mutate({ botId, volume: val });
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {isStreaming && (
                <div className="space-y-2 max-w-md">
                  <Label>Stream Volume ({streamVolume}%)</Label>
                  <Slider
                    value={[streamVolume]}
                    min={0}
                    max={100}
                    step={1}
                    onValueChange={([val]) => {
                      setStreamVolume(val);
                      setStreamVolumeMut.mutate({ botId, volume: val });
                    }}
                  />
                </div>
              )}

              <div className="flex gap-2">
                {!isStreaming ? (
                  <Button
                    onClick={handleStart}
                    disabled={!sourceUrl.trim() || startStream.isPending}
                  >
                    {startStream.isPending ? 'Starting...' : 'Start Stream'}
                  </Button>
                ) : (
                  <Button
                    onClick={handleStop}
                    variant="destructive"
                    disabled={stopStream.isPending}
                  >
                    {stopStream.isPending ? 'Stopping...' : 'Stop Stream'}
                  </Button>
                )}
              </div>

              {!isStreaming && (botStatus === 'playing' || botStatus === 'paused') && (
                <p className="text-xs text-warning">
                  Music is playing on this bot. Starting a stream stops it — you will be asked to confirm.
                </p>
              )}

              {!isStreaming && lastStop && (
                <p className={`text-xs ${
                  streamStatus?.lastStop?.reason === 'source_unreachable'
                    || streamStatus?.lastStop?.reason === 'encoder_failure'
                    || streamStatus?.lastStop?.reason === 'sidecar_failure'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                }`}
                >
                  Last stream: {lastStop}
                </p>
              )}

              {(startStream.isError || stopStream.isError || setSource.isError) && (
                <p className="text-sm text-red-500">
                  {(startStream.error as any)?.message ||
                    (stopStream.error as any)?.message ||
                    (setSource.error as any)?.message}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Viewers */}
      {isStreaming && streamStatus && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                Viewers ({streamStatus.viewerCount})
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {streamStatus.viewers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No viewers connected</p>
            ) : (
              <div className="space-y-2">
                {streamStatus.viewers.map((viewer: any) => {
                  const duration = Math.floor((Date.now() - viewer.joinedAt) / 1000);
                  const mins = Math.floor(duration / 60);
                  const secs = duration % 60;
                  return (
                    <div
                      key={viewer.clid}
                      className="flex items-center justify-between py-1.5 px-3 rounded bg-muted/50"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${
                          viewer.iceState === 'connected' ? 'bg-green-500' : 'bg-yellow-500'
                        }`} />
                        <span className="text-sm">Client #{viewer.clid}</span>
                        <span className="text-xs text-muted-foreground">
                          {mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-red-500 hover:text-red-400"
                        onClick={() => kickViewer.mutate({ botId, clid: viewer.clid })}
                      >
                        Kick
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isAdmin && <VideoStreamDefaultsCard server={server} />}
    </div>
  );
}
