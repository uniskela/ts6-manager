import { useState } from 'react';
import { playlistVoteApprovalsNeeded, type PlaylistVoteSettings } from '@ts6/common';
import { useServerStore } from '@/stores/server.store';
import { usePlaylistVoteSettings, useSavePlaylistVoteSettings } from '@/hooks/use-playlist-vote-settings';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';

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
  const [draft, setDraft] = useState<PlaylistVoteSettings | null>(null);
  const save = useSavePlaylistVoteSettings();
  const current = draft ?? settings;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(settings);
  const exampleNeeded = playlistVoteApprovalsNeeded(current.thresholdPercent, 5);

  const set = <K extends keyof PlaylistVoteSettings>(key: K, value: PlaylistVoteSettings[K]) =>
    setDraft({ ...current, [key]: value });

  return (
    <Card className="mb-5">
      <CardHeader>
        <CardTitle className="text-base">Playlist voting</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          For the selected server, virtual server #{sid}. Voting stays off after upgrading.
          When enabled, whole-playlist requests from chat and the listener remote need channel approval.
        </p>

        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div className="space-y-1">
            <Label htmlFor="playlist-vote-enabled">Require a vote for whole playlists</Label>
            <p className="text-xs text-muted-foreground">
              Off keeps today's behaviour: queue permission and size limit only.
            </p>
          </div>
          <Switch
            id="playlist-vote-enabled"
            checked={current.enabled}
            disabled={save.isPending}
            onCheckedChange={(enabled) => set('enabled', enabled)}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="playlist-vote-threshold">Pass threshold (%)</Label>
            <Input
              id="playlist-vote-threshold"
              type="number"
              min={1}
              max={100}
              step={1}
              disabled={save.isPending}
              value={Number.isFinite(current.thresholdPercent) ? current.thresholdPercent : ''}
              onChange={(event) => {
                const next = Number(event.target.value);
                set('thresholdPercent', Number.isFinite(next) ? next : current.thresholdPercent);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="playlist-vote-max-size">Maximum request size (tracks)</Label>
            <Input
              id="playlist-vote-max-size"
              type="number"
              min={1}
              max={500}
              step={1}
              disabled={save.isPending}
              value={Number.isFinite(current.maxRequestSize) ? current.maxRequestSize : ''}
              onChange={(event) => {
                const next = Number(event.target.value);
                set('maxRequestSize', Number.isFinite(next) ? next : current.maxRequestSize);
              }}
            />
          </div>
        </div>

        <div className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="playlist-vote-example">
          <p className="font-medium">Worked example</p>
          <p className="mt-1 text-muted-foreground">
            At {current.thresholdPercent}% with 5 human listeners in the bot's channel,
            {' '}{exampleNeeded} yes vote{exampleNeeded === 1 ? '' : 's'} {exampleNeeded === 1 ? 'is' : 'are'} needed
            (the requester counts as one automatic yes). A playlist longer than {current.maxRequestSize} tracks
            is refused before anyone votes.
          </p>
        </div>

        <Button
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate({ configId, sid, settings: current }, {
            onSuccess: () => { setDraft(null); toast.success('Playlist vote settings saved'); },
            onError: () => toast.error('Could not save playlist vote settings'),
          })}
        >
          {save.isPending ? 'Saving…' : 'Save vote settings'}
        </Button>
      </CardContent>
    </Card>
  );
}
