import { Label } from '@/components/ui/label';
import {
  ENCODER_OPTIONS, NO_VIEWER_TIMEOUT_OPTIONS, QUALITY_OPTIONS, SOURCE_MODE_OPTIONS,
} from '@/lib/video-streaming';
import type { VideoStartOptions } from '@/lib/video-options';

/**
 * Quality, encoder, no-viewer stop and source type for one console start.
 * "Default" choices use the server's streaming defaults; nothing is saved.
 */
export function VideoOptions({ value, onChange }: { value: VideoStartOptions; onChange(v: VideoStartOptions): void }) {
  const field = 'h-10 w-full rounded-md border bg-background px-2 text-sm';
  return (
    <fieldset className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
      <legend className="px-1 text-xs text-muted-foreground">Video options (this start only)</legend>
      <div className="space-y-1">
        <Label htmlFor="vo-quality">Quality</Label>
        <select id="vo-quality" className={field} value={value.quality}
          onChange={(e) => onChange({ ...value, quality: e.target.value as VideoStartOptions['quality'] })}>
          <option value="default">Default</option>
          {QUALITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="vo-encoder">Encoder</Label>
        <select id="vo-encoder" className={field} value={value.encoder}
          onChange={(e) => onChange({ ...value, encoder: e.target.value as VideoStartOptions['encoder'] })}>
          <option value="default">Default</option>
          {ENCODER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="vo-noviewer">Stop with no viewers after</Label>
        <select id="vo-noviewer" className={field} value={value.noViewerTimeout}
          onChange={(e) => onChange({ ...value, noViewerTimeout: e.target.value })}>
          {NO_VIEWER_TIMEOUT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="vo-source">Source type</Label>
        <select id="vo-source" className={field} value={value.sourceMode}
          onChange={(e) => onChange({ ...value, sourceMode: e.target.value as VideoStartOptions['sourceMode'] })}>
          {SOURCE_MODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    </fieldset>
  );
}
