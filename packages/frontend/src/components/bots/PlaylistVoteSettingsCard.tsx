import { useMemo, useState } from 'react';
import { playlistVoteApprovalsNeeded, type PlaylistVoteSettings } from '@ts6/common';
import { useServerStore } from '@/stores/server.store';
import { usePlaylistVoteSettings, useSavePlaylistVoteSettings } from '@/hooks/use-playlist-vote-settings';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';

const THRESHOLD_MIN = 1;
const THRESHOLD_MAX = 100;
const MAX_SIZE_MIN = 1;
const MAX_SIZE_MAX = 500;
const VOTE_WINDOW_SECONDS = 60;
const EXAMPLE_LISTENERS = 5;

type FieldKey = 'thresholdPercent' | 'maxRequestSize';
type FieldErrors = Partial<Record<FieldKey, string>>;

/** Parse a whole-number field; empty/fractional/out-of-range values stay invalid for save. */
export function parseVoteIntegerField(
  raw: string,
  min: number,
  max: number,
  label: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: `Enter ${label}.` };
  if (!/^-?\d+$/.test(trimmed)) return { ok: false, error: `${label} must be a whole number.` };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { ok: false, error: `${label} must be between ${min} and ${max}.` };
  }
  return { ok: true, value };
}

export function PlaylistVoteSettingsCard() {
  const { selectedConfigId, selectedSid } = useServerStore();
  const query = usePlaylistVoteSettings(selectedConfigId, selectedSid);

  if (!selectedConfigId || !selectedSid) {
    return <p className="text-sm text-muted-foreground">Select a server and virtual server to configure playlist voting.</p>;
  }
  if (query.isPending) return <p className="text-sm text-muted-foreground">Loading playlist vote settings…</p>;
  if (query.isError || !query.data) {
    return <p role="alert" className="text-sm text-destructive">Could not load playlist vote settings.</p>;
  }

  return (
    <SettingsEditor
      key={`${selectedConfigId}:${selectedSid}`}
      configId={selectedConfigId}
      sid={selectedSid}
      settings={query.data}
    />
  );
}

function SettingsEditor({ configId, sid, settings }: {
  configId: number; sid: number; settings: PlaylistVoteSettings;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [thresholdText, setThresholdText] = useState(String(settings.thresholdPercent));
  const [maxSizeText, setMaxSizeText] = useState(String(settings.maxRequestSize));
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useSavePlaylistVoteSettings();

  const thresholdParsed = parseVoteIntegerField(thresholdText, THRESHOLD_MIN, THRESHOLD_MAX, 'Pass threshold');
  const maxSizeParsed = parseVoteIntegerField(maxSizeText, MAX_SIZE_MIN, MAX_SIZE_MAX, 'Maximum request size');
  const valid = thresholdParsed.ok && maxSizeParsed.ok;

  const draft: PlaylistVoteSettings | null = valid
    ? { enabled, thresholdPercent: thresholdParsed.value, maxRequestSize: maxSizeParsed.value }
    : null;

  const dirty = draft
    ? draft.enabled !== settings.enabled
      || draft.thresholdPercent !== settings.thresholdPercent
      || draft.maxRequestSize !== settings.maxRequestSize
    : enabled !== settings.enabled
      || thresholdText !== String(settings.thresholdPercent)
      || maxSizeText !== String(settings.maxRequestSize);

  const exampleNeeded = useMemo(() => {
    if (!thresholdParsed.ok) return null;
    return playlistVoteApprovalsNeeded(thresholdParsed.value, EXAMPLE_LISTENERS);
  }, [thresholdParsed]);

  const validateFields = (): FieldErrors => {
    const next: FieldErrors = {};
    if (!thresholdParsed.ok) next.thresholdPercent = thresholdParsed.error;
    if (!maxSizeParsed.ok) next.maxRequestSize = maxSizeParsed.error;
    return next;
  };

  const onSave = () => {
    const nextErrors = validateFields();
    setErrors(nextErrors);
    if (!draft || Object.keys(nextErrors).length > 0) return;
    save.mutate({ configId, sid, settings: draft }, {
      onSuccess: () => toast.success('Playlist vote settings saved'),
      onError: () => toast.error('Could not save playlist vote settings'),
    });
  };

  const thresholdErrorId = 'playlist-vote-threshold-error';
  const maxSizeErrorId = 'playlist-vote-max-size-error';

  return (
    <Card className="mb-5">
      <CardHeader>
        <CardTitle className="text-base">Playlist voting</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          For the selected server, virtual server #{sid}. Voting stays off after upgrading.
          When enabled, whole-playlist requests from chat and the listener remote need channel approval
          within a {VOTE_WINDOW_SECONDS}-second window.
        </p>

        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div className="space-y-1">
            <Label htmlFor="playlist-vote-enabled">Require a vote for whole playlists</Label>
            <p className="text-xs text-muted-foreground">
              Off skips the vote window. The maximum playlist size still applies to whole-playlist
              requests from chat and the listener remote.
            </p>
          </div>
          <Switch
            id="playlist-vote-enabled"
            checked={enabled}
            disabled={save.isPending}
            onCheckedChange={setEnabled}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="playlist-vote-threshold">Pass threshold (%)</Label>
            <Input
              id="playlist-vote-threshold"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              disabled={save.isPending}
              value={thresholdText}
              aria-invalid={Boolean(errors.thresholdPercent)}
              aria-describedby={errors.thresholdPercent ? thresholdErrorId : 'playlist-vote-threshold-hint'}
              onChange={(event) => {
                setThresholdText(event.target.value);
                if (errors.thresholdPercent) setErrors((prev) => ({ ...prev, thresholdPercent: undefined }));
              }}
              onBlur={() => setErrors((prev) => ({ ...prev, ...validateFields() }))}
            />
            <p id="playlist-vote-threshold-hint" className="text-xs text-muted-foreground">Whole number from {THRESHOLD_MIN} to {THRESHOLD_MAX}.</p>
            {errors.thresholdPercent && (
              <p id={thresholdErrorId} role="alert" className="text-sm text-destructive">{errors.thresholdPercent}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="playlist-vote-max-size">Maximum request size (tracks)</Label>
            <Input
              id="playlist-vote-max-size"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              disabled={save.isPending}
              value={maxSizeText}
              aria-invalid={Boolean(errors.maxRequestSize)}
              aria-describedby={errors.maxRequestSize ? maxSizeErrorId : 'playlist-vote-max-size-hint'}
              onChange={(event) => {
                setMaxSizeText(event.target.value);
                if (errors.maxRequestSize) setErrors((prev) => ({ ...prev, maxRequestSize: undefined }));
              }}
              onBlur={() => setErrors((prev) => ({ ...prev, ...validateFields() }))}
            />
            <p id="playlist-vote-max-size-hint" className="text-xs text-muted-foreground">
              Whole number from {MAX_SIZE_MIN} to {MAX_SIZE_MAX}. Applies to whole-playlist requests
              whether voting is on or off.
            </p>
            {errors.maxRequestSize && (
              <p id={maxSizeErrorId} role="alert" className="text-sm text-destructive">{errors.maxRequestSize}</p>
            )}
          </div>
        </div>

        <div className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="playlist-vote-example">
          <p className="font-medium">How a vote works</p>
          {exampleNeeded != null && maxSizeParsed.ok ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>
                At {thresholdParsed.ok ? thresholdParsed.value : '—'}% with {EXAMPLE_LISTENERS} human listeners,
                {' '}{exampleNeeded} yes vote{exampleNeeded === 1 ? '' : 's'} {exampleNeeded === 1 ? 'is' : 'are'} needed.
              </li>
              <li>The requester counts as an automatic yes and still needs the queue permission.</li>
              <li>If the requester is the only human listener, the playlist queues immediately with no voting window.</li>
              <li>Otherwise the vote stays open for {VOTE_WINDOW_SECONDS} seconds, then fails if it is still behind.</li>
              <li>
                A playlist longer than {maxSizeParsed.value} tracks is refused before it is queued or put to a vote.
              </li>
            </ul>
          ) : (
            <p className="mt-1 text-muted-foreground">
              Enter a valid pass threshold and maximum request size to see the worked example.
            </p>
          )}
        </div>

        <Button
          disabled={!dirty || save.isPending || !valid}
          onClick={onSave}
        >
          {save.isPending ? 'Saving…' : 'Save vote settings'}
        </Button>
      </CardContent>
    </Card>
  );
}
