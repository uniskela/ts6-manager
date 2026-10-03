import { useRef } from 'react';
import type { MusicBotSummary } from '@ts6/common';
import { Button } from '@/components/ui/button';
import { BotAvatar } from '@/components/shared/BotAvatar';
import { useSetBotAvatarMode, useUploadBotAvatar } from '@/hooks/use-music-bots';
import { apiErrorMessage } from '@/lib/api-error';

export function BotAvatarSettings({ bot }: { bot: MusicBotSummary }) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useUploadBotAvatar();
  const setMode = useSetBotAvatarMode();
  const pending = upload.isPending || setMode.isPending;
  const error = upload.error ?? setMode.error;
  return (
    <section aria-labelledby={`avatar-settings-${bot.id}`} className="space-y-3 rounded-md border p-3">
      <h3 id={`avatar-settings-${bot.id}`} className="text-sm font-medium">Avatar</h3>
      <div className="flex items-center gap-3">
        <BotAvatar botId={bot.id} name={bot.name} mode={bot.avatarMode} md5={bot.avatarMd5} className="h-16 w-16" />
        <p className="text-xs text-muted-foreground">PNG, JPEG or GIF, at most 200 KB.</p>
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/gif" aria-label="Upload avatar"
        className="hidden" disabled={pending} onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setMode.reset();
          upload.mutate({ botId: bot.id, file });
        }} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="h-11" disabled={pending} onClick={() => input.current?.click()}>Upload</Button>
        <Button type="button" variant={bot.avatarMode === 'default' ? 'secondary' : 'outline'} className="h-11"
          aria-pressed={bot.avatarMode === 'default'} disabled={pending} onClick={() => {
            upload.reset();
            setMode.mutate({ botId: bot.id, mode: 'default' });
          }}>Use default</Button>
        <Button type="button" variant={bot.avatarMode === 'none' ? 'secondary' : 'outline'} className="h-11"
          aria-pressed={bot.avatarMode === 'none'} disabled={pending} onClick={() => {
            upload.reset();
            setMode.mutate({ botId: bot.id, mode: 'none' });
          }}>None</Button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{apiErrorMessage(error, 'Could not update avatar')}</p>}
      {bot.avatarError && <p role="alert" className="text-xs text-destructive">{bot.avatarError}</p>}
    </section>
  );
}
