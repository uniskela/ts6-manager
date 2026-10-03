/**
 * New bot / Edit bot dialog, shared by the Bot Hub and each bot's console.
 * Moved from the old Media Bots → Bots tab with the same fields and rules.
 */

import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { MusicBotSummary } from '@ts6/common';
import { musicBotsApi } from '@/api/music.api';
import { useCreateMusicBot, useUpdateMusicBot } from '@/hooks/use-music-bots';
import { useServers } from '@/hooks/use-servers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BotAvatarSettings } from '@/pages/media-bots/BotAvatarSettings';

/** TeamSpeak refuses a nickname outside these lengths (error 1541); the bot name is its nickname. */
const MIN_BOT_NICKNAME_LENGTH = 3;

const MAX_BOT_NICKNAME_LENGTH = 30;

function isBotNicknameLengthOk(name: string): boolean {
  const length = name.trim().length;
  return length >= MIN_BOT_NICKNAME_LENGTH && length <= MAX_BOT_NICKNAME_LENGTH;
}

/** Create can succeed server-side while the browser sees timeout / proxy 499. */
function isMusicBotCreateTransportFailure(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (err.code === 'ECONNABORTED' || err.code === 'ERR_CANCELED') return true;
  const status = err.response?.status;
  if (status === 499 || status === 408 || status === 504) return true;
  // Aborted before a status body (nginx 499 often surfaces as network error)
  if (!err.response) return true;
  return false;
}

interface BotForm {
  name: string;
  serverConfigId: string;
  serverPassword: string;
  defaultChannel: string;
  commandChannelsText: string;
  virtualServerId: number;
  channelPassword: string;
  voicePort: number;
  volume: number;
  autoStart: boolean;
}

const EMPTY_FORM: BotForm = {
  name: '',
  serverConfigId: '',
  serverPassword: '',
  defaultChannel: '',
  commandChannelsText: '',
  virtualServerId: 1,
  channelPassword: '',
  voicePort: 9987,
  volume: 50,
  autoStart: false,
};

function formFor(bot: MusicBotSummary): BotForm {
  return {
    name: bot.name,
    serverConfigId: String(bot.serverConfigId),
    serverPassword: bot.serverPassword || '',
    defaultChannel: bot.defaultChannel || '',
    commandChannelsText: (bot.commandChannelIds ?? []).join(', '),
    virtualServerId: bot.virtualServerId ?? 1,
    channelPassword: bot.channelPassword || '',
    voicePort: bot.voicePort ?? 9987,
    volume: bot.volume,
    autoStart: bot.autoStart,
  };
}

const parseCommandChannelsInput = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));

/** `bot` set = edit that bot; null = create a new one. */
export function BotFormDialog({ open, bot, onClose, defaultServerId }: {
  open: boolean;
  bot: MusicBotSummary | null;
  onClose: () => void;
  /** Pre-selected server for a new bot (usually the header's selection). */
  defaultServerId?: number | null;
}) {
  const queryClient = useQueryClient();
  const { data: servers } = useServers();
  const serverList = Array.isArray(servers) ? servers : [];
  const createBot = useCreateMusicBot();
  const updateBot = useUpdateMusicBot();
  const [form, setForm] = useState<BotForm>(EMPTY_FORM);

  // Reset the form when the dialog opens or switches bot. The bot list polls,
  // so a new `bot` object for the same bot must not wipe what is being typed.
  const botRef = useRef(bot);
  botRef.current = bot;
  const defaultServerRef = useRef(defaultServerId);
  defaultServerRef.current = defaultServerId;
  const botId = bot?.id ?? null;
  useEffect(() => {
    if (!open) return;
    const current = botRef.current;
    if (current) setForm(formFor(current));
    else setForm({ ...EMPTY_FORM, serverConfigId: defaultServerRef.current ? String(defaultServerRef.current) : '' });
  }, [open, botId]);

  // A saved bot can predate the limit, so its name may already be too long.
  const nameLengthError = form.name !== '' && !isBotNicknameLengthOk(form.name);

  const handleCreate = async () => {
    const configId = parseInt(form.serverConfigId);
    if (!configId) { toast.error('Please select a server'); return; }
    const createdName = form.name;
    // Bots that exist before this create, to recognise ours if the response is lost.
    let known = queryClient.getQueryData<MusicBotSummary[]>(['music-bots']);
    if (!Array.isArray(known)) {
      try {
        known = await queryClient.fetchQuery({ queryKey: ['music-bots'], queryFn: musicBotsApi.list });
      } catch {
        known = undefined;
      }
    }
    const knownIds = new Set((Array.isArray(known) ? known : []).map((b) => b.id));
    createBot.mutate({
      name: createdName,
      serverConfigId: configId,
      nickname: form.name.trim() || 'MediaBot',
      serverPassword: form.serverPassword || undefined,
      defaultChannel: form.defaultChannel || undefined,
      // Empty = same-channel voice cmds + SSH roaming helper (no create-time pin).
      virtualServerId: form.virtualServerId,
      channelPassword: form.channelPassword || undefined,
      voicePort: form.voicePort,
      volume: form.volume,
      autoStart: form.autoStart,
    }, {
      onSuccess: () => { toast.success('Media bot created'); void queryClient.invalidateQueries({ queryKey: ['bot-media'] }); onClose(); },
      onError: async (err) => {
        // Proxy/client often abort (499 / timeout) while the bot row already exists.
        if (isMusicBotCreateTransportFailure(err)) {
          try {
            const list = await queryClient.fetchQuery({
              queryKey: ['music-bots'],
              queryFn: musicBotsApi.list,
            });
            const latest = Array.isArray(list) ? list : [];
            const appeared = latest.some(
              (b: MusicBotSummary) => b.name === createdName && !knownIds.has(b.id),
            );
            if (appeared) {
              toast.success('Media bot created');
              void queryClient.invalidateQueries({ queryKey: ['bot-media'] });
              onClose();
              return;
            }
          } catch {
            // fall through to failure toast
          }
        }
        toast.error('Failed to create bot');
      },
    });
  };

  const handleUpdate = () => {
    if (!bot) return;
    updateBot.mutate({ id: bot.id, data: {
      name: form.name,
      nickname: form.name.trim(),
      serverPassword: form.serverPassword || undefined,
      defaultChannel: form.defaultChannel || undefined,
      commandChannelIds: parseCommandChannelsInput(form.commandChannelsText),
      virtualServerId: form.virtualServerId,
      channelPassword: form.channelPassword || undefined,
      voicePort: form.voicePort,
      volume: form.volume,
      autoStart: form.autoStart,
    }}, {
      onSuccess: () => { toast.success('Bot updated'); void queryClient.invalidateQueries({ queryKey: ['bot-media'] }); onClose(); },
      onError: () => toast.error('Failed to update bot'),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{bot ? 'Edit Media Bot' : 'New Media Bot'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Name</Label>
            <Input type="text" aria-label="Bot name and TeamSpeak nickname" aria-required="true" aria-invalid={nameLengthError} aria-describedby="bot-nickname-hint" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My Media Bot" maxLength={MAX_BOT_NICKNAME_LENGTH} />
            <p id="bot-nickname-hint" className={`text-[10px] mt-1 ${nameLengthError ? 'text-destructive' : 'text-muted-foreground'}`}>
              Also the bot's TeamSpeak nickname: {MIN_BOT_NICKNAME_LENGTH}-{MAX_BOT_NICKNAME_LENGTH} characters
              {nameLengthError && ` (now ${form.name.trim().length})`}.
            </p>
          </div>
          {!bot && (
            <div>
              <Label className="text-xs">Server</Label>
              <Select value={form.serverConfigId} onValueChange={(v) => setForm({ ...form, serverConfigId: v })}>
                <SelectTrigger aria-label="Server"><SelectValue placeholder="Select server..." /></SelectTrigger>
                <SelectContent>
                  {serverList.map((s: any) => (
                    <SelectItem key={s.id} value={String(s.id)}>{s.name} ({s.host})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label className="text-xs">Voice Port</Label>
            <Input type="number" value={form.voicePort} onChange={(e) => setForm({ ...form, voicePort: parseInt(e.target.value) || 9987 })} placeholder="9987" />
          </div>
          <div>
            <Label className="text-xs">Server Password</Label>
            <Input type="password" value={form.serverPassword} onChange={(e) => setForm({ ...form, serverPassword: e.target.value })} placeholder="Leave empty if none" />
          </div>
          <div>
            <Label className="text-xs">Default Channel</Label>
            <Input value={form.defaultChannel} onChange={(e) => setForm({ ...form, defaultChannel: e.target.value })} placeholder="Channel name or ID (playback channel)" />
          </div>
          {bot && (
            <div>
              <Label className="text-xs">Command channels (optional)</Label>
              <Input
                value={form.commandChannelsText}
                onChange={(e) => setForm({ ...form, commandChannelsText: e.target.value })}
                placeholder="e.g. 12, 45 — channel IDs where !commands work"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Leave empty to use same-channel voice commands plus the SSH roaming helper.
                Pin IDs only if you need fixed command rooms. Requires ServerQuery SSH.
              </p>
            </div>
          )}
          <div>
            <Label className="text-xs">Virtual server ID</Label>
            <Input
              type="number"
              min={1}
              value={form.virtualServerId}
              onChange={(e) => setForm({ ...form, virtualServerId: parseInt(e.target.value, 10) || 1 })}
            />
          </div>
          <div>
            <Label className="text-xs">Channel Password</Label>
            <Input type="password" value={form.channelPassword} onChange={(e) => setForm({ ...form, channelPassword: e.target.value })} placeholder="Leave empty if none" />
          </div>
          <div>
            <Label className="text-xs">Volume ({form.volume}%)</Label>
            <Slider value={[form.volume]} max={100} step={1} onValueChange={([v]) => setForm({ ...form, volume: v })} />
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={form.autoStart} onCheckedChange={(v) => setForm({ ...form, autoStart: v })} />
            <Label className="text-xs">Auto-start on server startup</Label>
          </div>
          {bot && <BotAvatarSettings key={bot.id} bot={bot} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { if (bot) handleUpdate(); else void handleCreate(); }} disabled={!isBotNicknameLengthOk(form.name) || (!bot && !form.serverConfigId) || createBot.isPending || updateBot.isPending}>
            {bot ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
