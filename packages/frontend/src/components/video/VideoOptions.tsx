import { Label } from '@/components/ui/label';
import { ChevronDown } from 'lucide-react';
import {
  ENCODER_OPTIONS, NO_VIEWER_TIMEOUT_OPTIONS, QUALITY_OPTIONS, SOURCE_MODE_OPTIONS,
} from '@/lib/video-streaming';
import { noViewerTimeoutLabel, videoOptionsSummary, type VideoStartOptions } from '@/lib/video-options';

/**
 * Quality, encoder, no-viewer stop and source type for one console start,
 * folded behind a "Video options" row that shows the current choices. They
 * start on the server's streaming defaults; nothing is saved.
 */
export function VideoOptions({ value, onChange }: { value: VideoStartOptions; onChange(v: VideoStartOptions): void }) {
  const field = 'h-10 w-full rounded-md border bg-background px-2 text-sm';
  // The server's timeout may be one the list doesn't offer (env or a custom value).
  const timeoutOptions = NO_VIEWER_TIMEOUT_OPTIONS.some((o) => o.value === value.noViewerTimeout)
    ? NO_VIEWER_TIMEOUT_OPTIONS
    : [{ value: value.noViewerTimeout, label: noViewerTimeoutLabel(value.noViewerTimeout) }, ...NO_VIEWER_TIMEOUT_OPTIONS];
  return (
    <details className="group rounded-md border">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 text-sm [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 font-medium">Video options</span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{videoOptionsSummary(value)}</span>
          <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
        </span>
      </summary>
      <div className="space-y-3 border-t p-3">
        <p className="text-xs text-muted-foreground">For this start only. Starts on this server's streaming defaults.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="vo-quality">Quality</Label>
            <select id="vo-quality" className={field} value={value.quality}
              onChange={(e) => onChange({ ...value, quality: e.target.value as VideoStartOptions['quality'] })}>
              {QUALITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="vo-encoder">Encoder</Label>
            <select id="vo-encoder" className={field} value={value.encoder}
              onChange={(e) => onChange({ ...value, encoder: e.target.value as VideoStartOptions['encoder'] })}>
              {ENCODER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="vo-noviewer">Stop with no viewers after</Label>
            <select id="vo-noviewer" className={field} value={value.noViewerTimeout}
              onChange={(e) => onChange({ ...value, noViewerTimeout: e.target.value })}>
              {timeoutOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="vo-source">Source type</Label>
            <select id="vo-source" className={field} value={value.sourceMode}
              onChange={(e) => onChange({ ...value, sourceMode: e.target.value as VideoStartOptions['sourceMode'] })}>
              {SOURCE_MODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
      </div>
    </details>
  );
}
