/**
 * Admin defaults for new video streams (no-viewer stop, Auto limit, encoder,
 * hardware preference, bitrate clamp) plus an on-demand encoder capability check.
 * Lives beside the stream controls so these settings stay in the media surface.
 */

import { useEffect, useState } from 'react';
import { Check, Loader2, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import type { VideoEncoderRequest, VideoStreamPresetKey, VideoStreamSettings } from '@ts6/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  useUpdateVideoStreamingSettings,
  useVideoEncoderCapabilities,
  useVideoStreamingSettings,
} from '@/hooks/use-video-streaming';
import { apiErrorMessage } from '@/lib/api-error';
import {
  AUTO_LIMIT_OPTIONS,
  ENCODER_LABELS,
  ENCODER_OPTIONS,
  formatTimeout,
} from '@/lib/video-streaming';

const TIMEOUT_PRESETS = ['0', '60', '300', '600', '1800'];

export function VideoStreamDefaultsCard() {
  const { data: settings } = useVideoStreamingSettings();
  const update = useUpdateVideoStreamingSettings();
  const encoders = useVideoEncoderCapabilities();
  const [draft, setDraft] = useState<VideoStreamSettings | null>(null);
  const [customTimeout, setCustomTimeout] = useState(false);

  useEffect(() => {
    if (settings) {
      setDraft(settings);
      setCustomTimeout(!TIMEOUT_PRESETS.includes(String(settings.noViewerTimeoutSec)));
    }
  }, [settings]);

  if (!draft) return null;

  const dirty = !!settings && JSON.stringify(settings) !== JSON.stringify(draft);
  const set = <K extends keyof VideoStreamSettings>(key: K, value: VideoStreamSettings[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const save = () => {
    update.mutate(draft, {
      onSuccess: () => toast.success('Streaming defaults saved — they apply to the next stream'),
      onError: (e) => toast.error(apiErrorMessage(e, 'Failed to save streaming defaults')),
    });
  };

  const checkEncoders = (refresh: boolean) => {
    encoders.check(refresh).catch(() => { /* surfaced via isError */ });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Streaming defaults</CardTitle>
        <p className="text-xs text-muted-foreground">
          Applied when a stream starts. Each stream can override quality, encoder and the no-viewer stop.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="no-viewer-timeout">Stop when nobody watches</Label>
            <Select
              value={customTimeout ? 'custom' : String(draft.noViewerTimeoutSec)}
              onValueChange={(v) => {
                if (v === 'custom') {
                  setCustomTimeout(true);
                } else {
                  setCustomTimeout(false);
                  set('noViewerTimeoutSec', Number(v));
                }
              }}
            >
              <SelectTrigger id="no-viewer-timeout"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIMEOUT_PRESETS.map((v) => (
                  <SelectItem key={v} value={v}>{formatTimeout(Number(v))}</SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            {customTimeout && (
              <Input
                type="number"
                min={0}
                max={86400}
                aria-label="Custom no-viewer timeout in seconds"
                value={draft.noViewerTimeoutSec}
                onChange={(e) => set('noViewerTimeoutSec', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              />
            )}
            <p className="text-xs text-muted-foreground">
              Separate from the channel-empty stop: frees the encoder when no TeamSpeak client has the stream open.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="auto-limit">Auto quality limit</Label>
            <Select
              value={draft.autoMaxPreset}
              onValueChange={(v) => set('autoMaxPreset', v as VideoStreamPresetKey)}
            >
              <SelectTrigger id="auto-limit"><SelectValue /></SelectTrigger>
              <SelectContent>
                {AUTO_LIMIT_OPTIONS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Auto matches the source resolution up to this preset and never upscales.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="default-encoder">Default encoder</Label>
            <Select
              value={draft.defaultEncoder}
              onValueChange={(v) => set('defaultEncoder', v as VideoEncoderRequest)}
            >
              <SelectTrigger id="default-encoder"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ENCODER_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2 pt-1">
              <Switch
                id="prefer-hardware"
                checked={draft.preferHardware}
                onCheckedChange={(v) => set('preferHardware', v)}
              />
              <Label htmlFor="prefer-hardware" className="text-sm font-normal">
                Auto prefers hardware (VAAPI) when a test encode succeeds
              </Label>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="max-bitrate">Bitrate limit (kbps)</Label>
            <Input
              id="max-bitrate"
              type="number"
              min={0}
              max={100000}
              value={draft.maxBitrateKbps}
              onChange={(e) => set('maxBitrateKbps', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            />
            <p className="text-xs text-muted-foreground">0 = no limit. Clamps every preset and custom bitrate.</p>
          </div>
        </div>

        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={!dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save defaults'}
          </Button>
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => settings && setDraft(settings)}>
              Reset
            </Button>
          )}
        </div>

        <div className="space-y-2 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">Encoder capabilities</p>
              <p className="text-xs text-muted-foreground">
                Runs short test encodes on the media sidecar. Hardware encoders need <code>/dev/dri</code> passed through.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => checkEncoders(!!encoders.caps)}
              disabled={encoders.isFetching}
            >
              {encoders.isFetching
                ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              {encoders.caps ? 'Re-test' : 'Check encoders'}
            </Button>
          </div>
          {encoders.isError && (
            <p className="text-xs text-destructive">
              {apiErrorMessage(encoders.error, 'Encoder check failed')}
            </p>
          )}
          {encoders.caps && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">
                VAAPI device {encoders.caps.vaapiDevice}:{' '}
                {encoders.caps.vaapiDevicePresent ? 'present' : 'not present'}
                {encoders.caps.hwDecode ? ' · GPU decode on' : ''}
              </p>
              <ul className="grid gap-1 sm:grid-cols-2">
                {encoders.caps.encoders.map((e) => (
                  <li key={e.id} className="flex items-start gap-2 rounded bg-muted/50 px-2.5 py-1.5 text-xs">
                    {e.available
                      ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-label="available" />
                      : <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="unavailable" />}
                    <span className="min-w-0">
                      <span className="font-medium">{ENCODER_LABELS[e.id] ?? e.id}</span>
                      {e.lowPower ? <span className="text-muted-foreground"> · low-power</span> : null}
                      {!e.available && e.error && (
                        <span className="block break-words text-muted-foreground">{e.error}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
