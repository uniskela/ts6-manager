import { useState } from 'react';
import { MEDIA_COMMAND_GROUPS, type MediaCommandGroup, type MediaCommandPermissions } from '@ts6/common';
import { useServerStore } from '@/stores/server.store';
import { useServerGroups } from '@/hooks/use-groups';
import { useMediaCommandPermissions, useSaveMediaCommandPermissions } from '@/hooks/use-chat-commands';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';

const descriptions: Record<MediaCommandGroup, string> = {
  playback: 'Playback and music controls',
  queue: 'Queue and playlist changes',
  video: 'Video and IPTV controls',
};

export function MediaCommandPermissions() {
  const { selectedConfigId, selectedSid } = useServerStore();
  const policy = useMediaCommandPermissions(selectedConfigId, selectedSid);
  const groups = useServerGroups();
  const serverGroups = (Array.isArray(groups.data) ? groups.data : []) as Array<{ sgid: number | string; name: string }>;

  if (!selectedConfigId || !selectedSid) return <p className="text-sm text-muted-foreground">Select a server and virtual server to configure built-in command permissions.</p>;
  if (policy.isPending) return <p className="text-sm text-muted-foreground">Loading command permissions…</p>;
  if (policy.isError || !policy.data) return <p role="alert" className="text-sm text-destructive">Could not load command permissions.</p>;

  return <PermissionEditor key={`${selectedConfigId}:${selectedSid}`} configId={selectedConfigId} sid={selectedSid}
    policy={policy.data} groups={serverGroups} groupsPending={groups.isPending} groupsError={groups.isError} />;
}

function PermissionEditor({ configId, sid, policy, groups, groupsPending, groupsError }: {
  configId: number; sid: number; policy: MediaCommandPermissions;
  groups: Array<{ sgid: number | string; name: string }>; groupsPending: boolean; groupsError: boolean;
}) {
  const [draft, setDraft] = useState<MediaCommandPermissions | null>(null);
  const save = useSaveMediaCommandPermissions();
  const current = draft ?? policy;
  const update = (group: MediaCommandGroup, access: MediaCommandPermissions[MediaCommandGroup]) =>
    setDraft({ ...current, [group]: access });

  return (
    <Card className="mb-5">
      <CardHeader><CardTitle className="text-base">Built-in command permissions</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">For the selected server, virtual server #{sid}. Everyone remains the default after upgrading. Help and information commands stay accessible; !voteskip is available to human listeners.</p>
        {MEDIA_COMMAND_GROUPS.map((group) => {
          const access = current[group];
          const ids = access.mode === 'server_groups' ? access.serverGroupIds : [];
          const available = groups.map((g) => ({ id: Number(g.sgid), name: g.name })).filter((g) => Number.isSafeInteger(g.id) && g.id > 0);
          for (const id of ids) {
            if (!available.some((g) => g.id === id)) available.push({ id, name: `Unavailable group #${id}` });
          }
          return (
            <fieldset key={group} disabled={save.isPending} className="space-y-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{descriptions[group]}</legend>
              <label htmlFor={`media-access-${group}`} className="block text-sm">Who can use this?</label>
              <Select value={access.mode} onValueChange={(mode) => update(group, mode === 'everyone' ? { mode: 'everyone' } : { mode: 'server_groups', serverGroupIds: [] })}>
                <SelectTrigger id={`media-access-${group}`} className="max-w-xs"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="everyone">Everyone</SelectItem><SelectItem value="server_groups">Selected TeamSpeak server groups</SelectItem></SelectContent>
              </Select>
              {access.mode === 'server_groups' && (
                <div className="space-y-2">
                  {groupsPending && <p className="text-xs text-muted-foreground">Loading server groups…</p>}
                  {groupsError && <p role="alert" className="text-xs text-destructive">Server groups could not be loaded. Saved group IDs can still be removed.</p>}
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {available.map(({ id, name }) => (
                      <label key={id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={ids.includes(id)} onChange={(event) => update(group, {
                          mode: 'server_groups', serverGroupIds: event.target.checked ? [...ids, id] : ids.filter((value) => value !== id),
                        })} />
                        {name} <span className="text-xs text-muted-foreground">#{id}</span>
                      </label>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">Membership in any selected group grants access. No selected groups denies these controls to everyone.</p>
                </div>
              )}
            </fieldset>
          );
        })}
        <Button disabled={!draft || save.isPending} onClick={() => save.mutate({ configId, sid, policy: current }, {
          onSuccess: () => { setDraft(null); toast.success('Command permissions saved'); },
          onError: () => toast.error('Could not save command permissions'),
        })}>{save.isPending ? 'Saving…' : 'Save permissions'}</Button>
      </CardContent>
    </Card>
  );
}
