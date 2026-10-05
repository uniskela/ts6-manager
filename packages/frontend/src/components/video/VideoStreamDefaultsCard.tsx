/**
 * Admin defaults for new video streams: Performance/Balanced/Quality profiles,
 * with Advanced knobs (Auto limit, encoder, bitrate, cpu-used, no-viewer stop)
 * collapsed by default. Encoder capability check stays below.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import type { VideoEncodeProfile, VideoEncoderCapability, VideoEncoderRequest, VideoStreamPresetKey, VideoStreamSettings } from '@ts6/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  useServerVideoStreamingSettings,
  useUpdateServerVideoStreamingSettings,
  useUpdateVideoStreamingSettings,
  useVideoEncoderCapabilities,
  useVideoStreamingSettings,
} from '@/hooks/use-video-streaming';
import { apiErrorMessage } from '@/lib/api-error';
import { ENCODE_PROFILE_PRESETS, applyEncodeProfile, type NamedEncodeProfile } from '@/lib/encode-profiles';
import {
  AUTO_LIMIT_OPTIONS,
  ENCODER_LABELS,
  ENCODER_OPTIONS,
  formatTimeout,
} from '@/lib/video-streaming';
import { cn } from '@/lib/utils';

const TIMEOUT_PRESETS = ['0', '60', '300', '600', '1800'];
const NAMED_PROFILES = Object.keys(ENCODE_PROFILE_PRESETS) as NamedEncodeProfile[];

const FIELD_LABELS: Record<keyof VideoStreamSettings, string> = {
  noViewerTimeoutSec: 'no-viewer stop',
  announceAutoStops: 'auto-stop announcements',
  autoMaxPreset: 'Auto limit',
  defaultEncoder: 'encoder',
  preferHardware: 'hardware preference',
  maxBitrateKbps: 'bitrate limit',
  encodeProfile: 'encode profile',
  cpuUsed: 'encode speed',
};

interface VideoStreamDefaultsCardProps {
  /** The selected bot's server; enables per-server overrides. */
  server?: { id: number; name: string } | null;
}

export function VideoStreamDefaultsCard({ server }: VideoStreamDefaultsCardProps) {
  const [scope, setScope] = useState<'global' | 'server'>('global');
  const serverScope = scope === 'server' && !!server;
  const globalQuery = useVideoStreamingSettings();
  const serverQuery = useServerVideoStreamingSettings(server?.id);
  const settings = serverScope ? serverQuery.data?.effective : globalQuery.data;
  const overrides = serverQuery.data?.overrides ?? {};
  const updateGlobal = useUpdateVideoStreamingSettings();
  const updateServer = useUpdateServerVideoStreamingSettings(server?.id);
  const update = serverScope ? updateServer : updateGlobal;
  const encoders = useVideoEncoderCapabilities();
  const [draft, setDraft] = useState<VideoStreamSettings | null>(null);
  const [customTimeout, setCustomTimeout] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const draftRef = useRef<VideoStreamSettings | null>(null);
  const prevSettingsRef = useRef<VideoStreamSettings | null>(null);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    draftRef.current = null;
    prevSettingsRef.current = null;
    setDraft(null);
  }, [serverScope]);

  useEffect(() => {
    if (!settings) return;
    const prev = prevSettingsRef.current;
    const current = draftRef.current;
    const acceptServer =
      current === null || (prev !== null && JSON.stringify(current) === JSON.stringify(prev));
    if (acceptServer) {
      setDraft(settings);
      setCustomTimeout(!TIMEOUT_PRESETS.includes(String(settings.noViewerTimeoutSec)));
    }
    prevSettingsRef.current = settings;
  }, [settings]);

  if (!draft) return null;

  const dirty = !!settings && JSON.stringify(settings) !== JSON.stringify(draft);
  const set = <K extends keyof VideoStreamSettings>(key: K, value: VideoStreamSettings[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const setAdvanced = <K extends keyof VideoStreamSettings>(key: K, value: VideoStreamSettings[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value, encodeProfile: 'custom' as VideoEncodeProfile } : d));

  const selectProfile = (profile: NamedEncodeProfile) => {
    setDraft((d) => (d ? { ...d, ...applyEncodeProfile(profile) } : d));
  };

  const save = () => {
    update.mutate(draft, {
      onSuccess: () => toast.success(serverScope
        ? `Defaults for ${server?.name} saved — they apply to the next stream there`
        : 'Streaming defaults saved — they apply to the next stream'),
      onError: (e) => toast.error(apiErrorMessage(e, 'Failed to save streaming defaults')),
    });
  };

  const checkEncoders = (refresh: boolean) => {
    encoders.check(refresh).catch(() => { /* surfaced via isError */ });
  };

  const profileValue: VideoEncodeProfile = draft.encodeProfile ?? 'custom';

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Streaming defaults</CardTitle>
        <p className="text-xs text-muted-foreground">
          Applied when a stream starts. Each stream can override quality, encoder and the no-viewer stop.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {server && (
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="defaults-scope" className="text-sm">Applies to</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as 'global' | 'server')}>
              <SelectTrigger id="defaults-scope" className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="global">All servers</SelectItem>
                <SelectItem value="server">{server.name} only</SelectItem>
              </SelectContent>
            </Select>
            {serverScope && (
              <span className="text-xs text-muted-foreground">
                {Object.keys(overrides).length > 0
                  ? `Overrides: ${(Object.keys(overrides) as Array<keyof VideoStreamSettings>).map((k) => FIELD_LABELS[k]).join(', ')}`
                  : 'Inherits every global default'}
              </span>
            )}
          </div>
        )}

        <div className="space-y-2">
          <Label>Encode profile</Label>
          <div className="grid gap-2 sm:grid-cols-3">
            {NAMED_PROFILES.map((id) => {
              const p = ENCODE_PROFILE_PRESETS[id];
              const active = profileValue === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => selectProfile(id)}
                  className={cn(
                    'rounded-md border px-3 py-2 text-left text-sm transition-colors',
                    active ? 'border-primary bg-primary/5' : 'hover:border-primary/40',
                  )}
                >
                  <span className="font-medium">{p.label}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{p.hint}</span>
                </button>
              );
            })}
          </div>
          {profileValue === 'custom' && (
            <p className="text-xs text-muted-foreground">Custom — Advanced settings differ from the named profiles.</p>
          )}
        </div>

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
        </div>

        <div className="flex items-start gap-2">
          <Switch
            id="announce-auto-stops"
            checked={draft.announceAutoStops}
            onCheckedChange={(v) => set('announceAutoStops', v)}
          />
          <div className="space-y-0.5">
            <Label htmlFor="announce-auto-stops" className="text-sm font-normal">
              Announce auto-stops in chat
            </Label>
            <p className="text-xs text-muted-foreground">
              Posts one line in the bot&apos;s channel when it stops by itself. When the no-viewer stop is longer than 1 minute, it also warns 1 minute before stopping a stream nobody is watching.
            </p>
          </div>
        </div>

        <div className="rounded-md border">
          <button
            type="button"
            className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
            onClick={() => setAdvancedOpen((o) => !o)}
            aria-expanded={advancedOpen}
          >
            Advanced quality settings
            <ChevronDown className={cn('h-4 w-4 transition-transform', advancedOpen && 'rotate-180')} />
          </button>
          {advancedOpen && (
            <div className="grid gap-4 border-t px-3 py-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="auto-limit">Auto quality limit</Label>
                <Select
                  value={draft.autoMaxPreset}
                  onValueChange={(v) => setAdvanced('autoMaxPreset', v as VideoStreamPresetKey)}
                >
                  <SelectTrigger id="auto-limit"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {AUTO_LIMIT_OPTIONS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="max-bitrate">Bitrate limit (kbps)</Label>
                <Input
                  id="max-bitrate"
                  type="number"
                  min={0}
                  max={100000}
                  value={draft.maxBitrateKbps}
                  onChange={(e) => setAdvanced('maxBitrateKbps', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                />
                <p className="text-xs text-muted-foreground">0 = no limit.</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="cpu-used">Encode speed (cpu-used)</Label>
                <Input
                  id="cpu-used"
                  type="number"
                  min={0}
                  max={8}
                  value={draft.cpuUsed}
                  onChange={(e) => setAdvanced('cpuUsed', Math.min(8, Math.max(0, Math.floor(Number(e.target.value) || 0))))}
                />
                <p className="text-xs text-muted-foreground">
                  0 = use sidecar default (VIDEO_CPU_USED / VIDEO_VP9_CPU_USED).
                  1–8 override software VP8/VP9 (higher is faster / softer). Hardware ignores this.
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
                    Auto prefers hardware (VAAPI or NVENC) when a test encode succeeds
                  </Label>
                </div>
              </div>
            </div>
          )}
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
          {serverScope && Object.keys(overrides).length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={updateServer.isPending}
              onClick={() => updateServer.mutate({}, {
                onSuccess: () => toast.success(`${server?.name} now uses the global defaults`),
                onError: (e) => toast.error(apiErrorMessage(e, 'Failed to reset server defaults')),
              })}
            >
              Use global defaults
            </Button>
          )}
        </div>

        <div className="space-y-2 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">Encoder capabilities</p>
              <p className="text-xs text-muted-foreground">
                Runs short test encodes on the media sidecar. VAAPI encoders need <code>/dev/dri</code> passed through; NVENC needs the NVIDIA container runtime.
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
                  <li key={e.id} className="flex min-w-0 items-start gap-2 rounded bg-muted/50 px-2.5 py-1.5 text-xs">
                    {e.available
                      ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-label="available" />
                      : <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="unavailable" />}
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{ENCODER_LABELS[e.id] ?? e.id}</span>
                      {e.lowPower ? <span className="text-muted-foreground"> · low-power</span> : null}
                      {!e.available && e.error && (
                        <span className="block break-words text-muted-foreground">{e.error}</span>
                      )}
                      <EncoderProbeOutput encoder={e} />
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

/**
 * Collapsible ffmpeg log for one encoder check: each test encode's command,
 * how it ended and what ffmpeg printed. A check skipped without running
 * ffmpeg says why instead.
 */
function EncoderProbeOutput({ encoder }: { encoder: VideoEncoderCapability }) {
  const attempts = encoder.attempts ?? [];
  return (
    <details className="group mt-1 text-muted-foreground">
      <summary className="inline-flex cursor-pointer select-none list-none items-center gap-1 rounded-sm text-[11px] outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
        ffmpeg output
      </summary>
      <div className="mt-1 space-y-1.5">
        {attempts.length === 0 ? (
          encoder.skipped ? (
            <p className="text-[11px]">ffmpeg was not run: {encoder.skipped}.</p>
          ) : encoder.detail ? (
            <pre className="whitespace-pre-wrap break-words rounded bg-background/60 p-1.5 font-mono text-[11px]">{encoder.detail}</pre>
          ) : (
            // Sidecars older than this UI report no per-attempt output.
            <p className="text-[11px]">No ffmpeg output was reported. Update the media sidecar to see it.</p>
          )
        ) : attempts.map((a, i) => (
          <div key={i} className="space-y-0.5 rounded bg-background/60 p-1.5 font-mono text-[11px]">
            {attempts.length > 1 && (
              <p className="font-sans text-muted-foreground">
                Attempt {i + 1}{a.lowPower ? ' (low-power)' : ''}
              </p>
            )}
            <p className="break-words text-foreground/80">$ {a.command}</p>
            <p className={a.ok ? 'text-success' : 'text-destructive'}>→ {a.result}</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{a.output || '(no output)'}</pre>
          </div>
        ))}
      </div>
    </details>
  );
}
