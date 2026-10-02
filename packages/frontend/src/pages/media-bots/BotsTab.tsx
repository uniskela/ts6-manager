import { useState } from 'react';
import axios from 'axios';
import { Link as RouterLink } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { musicBotsApi } from '@/api/music.api';
import {
  useMusicBots,
  useCreateMusicBot,
  useUpdateMusicBot,
  useDeleteMusicBot,
  usePlaySong,
  usePlayUrl,
  useEnqueue,
  useLoadPlaylist,
  useBotMedia,
} from '@/hooks/use-music-bots';
import { useServers } from '@/hooks/use-servers';
import { useServerStore } from '@/stores/server.store';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { CONNECTION_SETUP_PATH, ConnectionRequiredNotice, useConnectionAvailability } from '@/components/shared/NoServerSelectedState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Music, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { toastMediaStarted } from '@/lib/media-start-toast';
import { hubLastStop } from '@/lib/bot-hub';
import type { MusicBotSummary } from '@ts6/common';
import { formatNumber } from '@/lib/formatting';
import { BotPlayerCard } from './BotPlayerCard';
import { PlaySongDialog } from './PlaySongDialog';


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


// ─── Bots Tab ────────────────────────────────────────────────────────────────

/** TeamSpeak refuses a nickname outside these lengths (error 1541); the bot name is its nickname. */
const MIN_BOT_NICKNAME_LENGTH = 3;

const MAX_BOT_NICKNAME_LENGTH = 30;


function isBotNicknameLengthOk(name: string): boolean {
  const length = name.trim().length;
  return length >= MIN_BOT_NICKNAME_LENGTH && length <= MAX_BOT_NICKNAME_LENGTH;
}


export function BotsTab() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useMusicBots();
  const { data: mediaOverview } = useBotMedia();
  const { data: servers } = useServers();
  const { selectedConfigId } = useServerStore();
  const createBot = useCreateMusicBot();
  const updateBot = useUpdateMusicBot();
  const deleteBot = useDeleteMusicBot();
  const playSong = usePlaySong();
  const playUrl = usePlayUrl();
  const enqueueSong = useEnqueue();
  const loadPlaylist = useLoadPlaylist();
  const now = Date.now();
  const lastStopByBot = new Map(
    (mediaOverview ?? []).map((m) => [m.botId, hubLastStop(m, now)]),
  );

  const [showCreate, setShowCreate] = useState(false);
  const [editBot, setEditBot] = useState<MusicBotSummary | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [showPlayDialog, setShowPlayDialog] = useState<number | null>(null);
  const [playDialogTab, setPlayDialogTab] = useState<'songs' | 'playlists'>('songs');

  // Create form
  const [form, setForm] = useState({
    name: '',
    serverConfigId: '',
    nickname: 'MediaBot',
    serverPassword: '',
    defaultChannel: '',
    commandChannelsText: '',
    virtualServerId: 1,
    channelPassword: '',
    voicePort: 9987,
    volume: 50,
    autoStart: false,
  });
  // A saved bot can predate the limit, so its name may already be too long.
  const nameLengthError = form.name !== '' && !isBotNicknameLengthOk(form.name);

  const parseCommandChannelsInput = (text: string): string[] =>
    text
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));

  const bots = Array.isArray(data) ? data : [];
  const serverList = Array.isArray(servers) ? servers : [];
  const { isPending: connectionsPending, hasNoConnections } = useConnectionAvailability();
  const createBlocked = connectionsPending || hasNoConnections;

  if (isLoading) return <PageLoader />;

  const handleCreate = () => {
    const configId = parseInt(form.serverConfigId);
    if (!configId) { toast.error('Please select a server'); return; }
    const createdName = form.name;
    const knownIds = new Set(bots.map((b) => b.id));
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
      onSuccess: () => { toast.success('Media bot created'); setShowCreate(false); resetForm(); },
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
              setShowCreate(false);
              resetForm();
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
    if (!editBot) return;
    updateBot.mutate({ id: editBot.id, data: {
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
      onSuccess: () => { toast.success('Bot updated'); setEditBot(null); },
      onError: () => toast.error('Failed to update bot'),
    });
  };

  const resetForm = () =>
    setForm({
      name: '',
      serverConfigId: '',
      nickname: 'MediaBot',
      serverPassword: '',
      defaultChannel: '',
      commandChannelsText: '',
      virtualServerId: 1,
      channelPassword: '',
      voicePort: 9987,
      volume: 50,
      autoStart: false,
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{formatNumber(bots.length)} media bot{bots.length !== 1 ? 's' : ''}</p>
        <Button size="sm" disabled={createBlocked} onClick={() => { resetForm(); setShowCreate(true); }}>
          <Plus className="h-4 w-4 mr-1" /> New Bot
        </Button>
      </div>

      {bots.length > 0 && hasNoConnections && (
        <ConnectionRequiredNotice>New media bots need a TeamSpeak server connection.</ConnectionRequiredNotice>
      )}

      {bots.length === 0 && hasNoConnections ? (
        <EmptyState icon={Music} title="Connect a TeamSpeak server first" description="Media bots join a server connection. Add one in Settings → Connections, then create your first bot.">
          <Button size="sm" asChild>
            <RouterLink to={CONNECTION_SETUP_PATH}>Open connection setup</RouterLink>
          </Button>
        </EmptyState>
      ) : bots.length === 0 ? (
        <EmptyState icon={Music} title="No media bots yet" description="Create your first voice bot to play music, radio, or video on your TeamSpeak server." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {bots.map((bot: MusicBotSummary) => (
            <BotPlayerCard
              key={bot.id}
              bot={bot}
              lastStopLine={lastStopByBot.get(bot.id) ?? null}
              onEdit={() => {
                setForm({
                  name: bot.name,
                  serverConfigId: String(bot.serverConfigId),
                  nickname: bot.nickname,
                  serverPassword: bot.serverPassword || '',
                  defaultChannel: bot.defaultChannel || '',
                  commandChannelsText: (bot.commandChannelIds ?? []).join(', '),
                  virtualServerId: bot.virtualServerId ?? 1,
                  channelPassword: bot.channelPassword || '',
                  voicePort: bot.voicePort ?? 9987,
                  volume: bot.volume,
                  autoStart: bot.autoStart,
                });
                setEditBot(bot);
              }}
              onDelete={() => setDeleteId(bot.id)}
              onPlayAction={(action) => {
                if (action === 'song' || action === 'playlist') {
                  setPlayDialogTab(action === 'playlist' ? 'playlists' : 'songs');
                  setShowPlayDialog(bot.id);
                }
              }}
            />
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={showCreate || editBot !== null} onOpenChange={(open) => { if (!open) { setShowCreate(false); setEditBot(null); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editBot ? 'Edit Media Bot' : 'New Media Bot'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Name</Label>
              <Input type="text" aria-label="Bot name and TeamSpeak nickname" aria-required="true" aria-invalid={nameLengthError} aria-describedby="bot-nickname-hint" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My Media Bot" maxLength={MAX_BOT_NICKNAME_LENGTH} />
              <p id="bot-nickname-hint" className={`text-[10px] mt-1 ${nameLengthError ? 'text-destructive' : 'text-muted-foreground'}`}>
                Also the bot's TeamSpeak nickname: {MIN_BOT_NICKNAME_LENGTH}-{MAX_BOT_NICKNAME_LENGTH} characters
                {nameLengthError && ` (now ${form.name.trim().length})`}.
              </p>
            </div>
            {!editBot && (
              <div>
                <Label className="text-xs">Server</Label>
                <Select value={form.serverConfigId} onValueChange={(v) => setForm({ ...form, serverConfigId: v })}>
                  <SelectTrigger><SelectValue placeholder="Select server..." /></SelectTrigger>
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
            {editBot && (
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreate(false); setEditBot(null); }}>Cancel</Button>
            <Button onClick={editBot ? handleUpdate : handleCreate} disabled={!isBotNicknameLengthOk(form.name) || (!editBot && !form.serverConfigId) || createBot.isPending || updateBot.isPending}>
              {editBot ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Media Bot?"
        description="This will permanently delete this media bot and disconnect it from the server."
        onConfirm={() => {
          if (deleteId) deleteBot.mutate(deleteId, { onSuccess: () => { toast.success('Bot deleted'); setDeleteId(null); } });
        }}
        destructive
      />

      {/* Play Song Dialog */}
      <PlaySongDialog
        botId={showPlayDialog}
        initialTab={playDialogTab}
        onClose={() => setShowPlayDialog(null)}
        onPlaySong={(songId) => {
          if (showPlayDialog) {
            playSong.mutate({ botId: showPlayDialog, songId }, {
              onSuccess: () => { toastMediaStarted('Playing'); setShowPlayDialog(null); },
              onError: () => toast.error('Failed to play song'),
            });
          }
        }}
        onPlayUrl={(url) => {
          if (showPlayDialog) {
            playUrl.mutate({ botId: showPlayDialog, url }, {
              onSuccess: () => { toastMediaStarted('Playing URL'); setShowPlayDialog(null); },
              onError: () => toast.error('Failed to play URL'),
            });
          }
        }}
        onEnqueue={(songId) => {
          if (showPlayDialog) {
            enqueueSong.mutate({ botId: showPlayDialog, songId }, {
              onSuccess: () => toast.success('Added to queue'),
              onError: () => toast.error('Failed to enqueue'),
            });
          }
        }}
        onLoadPlaylist={(playlistId) => {
          if (showPlayDialog) {
            loadPlaylist.mutate({ botId: showPlayDialog, playlistId, clearFirst: true }, {
              onSuccess: (data: { playError?: string }) => {
                if (data?.playError) {
                  toast.error(`Playlist queued but playback failed: ${data.playError}`);
                } else {
                  toastMediaStarted('Playlist loaded');
                }
                setShowPlayDialog(null);
              },
              onError: () => toast.error('Failed to load playlist'),
            });
          }
        }}
      />
    </div>
  );
}

