import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMusicBots } from '@/hooks/use-music-bots';
import {
  useSongs,
  useYouTubeDownload,
  useYouTubeInfo,
  useYouTubeDownloadBatch,
  useYouTubeRegister,
  useYouTubeImportPlaylist,
  useYouTubeImportStatus,
} from '@/hooks/use-music-library';
import {
  usePlaylists,
  usePlaylist,
  useCreatePlaylist,
  useUpdatePlaylist,
  useDeletePlaylist,
  useAddSongToPlaylist,
  useAddPlaylistToPlaylist,
  useRemoveSongFromPlaylist,
} from '@/hooks/use-playlists';
import { useServerStore } from '@/stores/server.store';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Music,
  Plus,
  Trash2,
  Download,
  ListMusic,
  Pencil,
  X,
  Loader2,
  Youtube,
  FileAudio,
  Link,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  MusicBotSummary,
  SongInfo,
  PlaylistSummary,
  PlaylistDetail,
  PlaylistMode,
} from '@ts6/common';
import { settingsApi } from '@/api/settings.api';
import { formatTime, UrlLoadInfo, youtubeInfoErrorMessage, urlInfoPlaylistLabel, urlItemSelectKey, allUrlItemKeys, selectedUrlItems, importJobProgressLabel, importJobCompleteMessage, importCapHint } from './shared';
import { ImportQueueOptions } from './ImportQueueOptions';


// ─── Playlists Tab ───────────────────────────────────────────────────────────

export function PlaylistsTab() {
  const qc = useQueryClient();
  const { selectedConfigId } = useServerStore();
  const { data, isLoading } = usePlaylists(selectedConfigId ?? undefined);
  const createPlaylist = useCreatePlaylist();
  const updatePlaylist = useUpdatePlaylist();
  const deletePlaylist = useDeletePlaylist();
  const addSong = useAddSongToPlaylist();
  const addFromPlaylist = useAddPlaylistToPlaylist();
  const removeSong = useRemoveSongFromPlaylist();
  const ytInfo = useYouTubeInfo();
  const ytDownload = useYouTubeDownload();
  const ytBatchDownload = useYouTubeDownloadBatch();
  const ytRegister = useYouTubeRegister();
  const ytImportPlaylist = useYouTubeImportPlaylist();
  const { data: playlistImportLimits } = useQuery({
    queryKey: ['settings-limits'],
    queryFn: settingsApi.getLimits,
    staleTime: 60_000,
  });
  const maxPlaylistImport = playlistImportLimits?.maxPlaylistImport ?? 250;
  const { data: playlistMusicBotsData } = useMusicBots();
  const playlistMusicBots = (Array.isArray(playlistMusicBotsData) ? playlistMusicBotsData : []) as MusicBotSummary[];

  const { data: songs } = useSongs(selectedConfigId);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMode, setNewMode] = useState<PlaylistMode>('local');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [showAddSong, setShowAddSong] = useState(false);
  const [addTab, setAddTab] = useState<'songs' | 'playlists' | 'url'>('songs');
  const [songFilter, setSongFilter] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState('');
  const [editMode, setEditMode] = useState<PlaylistMode>('local');
  const [addYtUrl, setAddYtUrl] = useState('');
  const [addUrlInfo, setAddUrlInfo] = useState<UrlLoadInfo | null>(null);
  const [addSelectedUrlIds, setAddSelectedUrlIds] = useState<Set<string>>(new Set());
  const [addBatchProgress, setAddBatchProgress] = useState<string | null>(null);
  const [addImportJobId, setAddImportJobId] = useState<string | null>(null);
  const [importQueueBotId, setImportQueueBotId] = useState('');
  const [importClearQueue, setImportClearQueue] = useState(false);

  const { data: detail } = usePlaylist(selectedId) as { data: PlaylistDetail | undefined };
  const { data: addImportJob } = useYouTubeImportStatus(selectedConfigId, addImportJobId);

  const playlists = (Array.isArray(data) ? data : []) as PlaylistSummary[];
  const songList = (Array.isArray(songs) ? songs : []) as SongInfo[];
  const playlistMode: PlaylistMode = detail?.mode === 'stream' ? 'stream' : 'local';
  const playlistSongIds = new Set((detail?.songs || []).map((s: any) => s.id));
  const isYtLinked = !!detail?.youtubePlaylistId;

  const songMatchesMode = (source: string) =>
    playlistMode === 'local' ? source === 'local' : source === 'youtube' || source === 'url';

  const availableSongs = songList.filter(
    (s) =>
      !playlistSongIds.has(s.id) &&
      songMatchesMode(s.source) &&
      (!songFilter ||
        s.title.toLowerCase().includes(songFilter.toLowerCase()) ||
        (s.artist || '').toLowerCase().includes(songFilter.toLowerCase())),
  );

  const otherPlaylists = playlists.filter((pl) => pl.id !== selectedId);

  const resetAddUrlState = () => {
    setAddYtUrl('');
    setAddUrlInfo(null);
    setAddSelectedUrlIds(new Set());
    setAddBatchProgress(null);
    setAddImportJobId(null);
  };

  // Playlists belong to a server: switching servers closes the old server's
  // playlist and anything open for it.
  const shownConfigId = useRef(selectedConfigId);
  useEffect(() => {
    if (shownConfigId.current === selectedConfigId) return;
    shownConfigId.current = selectedConfigId;
    setSelectedId(null);
    setShowEdit(false);
    setShowAddSong(false);
    setDeleteId(null);
    setSongFilter('');
    setAddTab('songs');
    setImportQueueBotId('');
    resetAddUrlState();
  }, [selectedConfigId]);

  const handleCreate = () => {
    createPlaylist.mutate(
      { name: newName, mode: newMode, serverConfigId: selectedConfigId ?? undefined },
      {
        onSuccess: () => {
          toast.success('Playlist created');
          setShowCreate(false);
          setNewName('');
          setNewMode('local');
        },
        onError: () => toast.error('Failed to create playlist'),
      },
    );
  };

  const openEdit = () => {
    if (!detail) return;
    setEditName(detail.name);
    setEditMode(detail.mode === 'stream' ? 'stream' : 'local');
    setShowEdit(true);
  };

  const handleEditSave = () => {
    if (!selectedId || !editName.trim()) return;
    const modeChanging = editMode !== playlistMode && !isYtLinked;
    updatePlaylist.mutate(
      {
        id: selectedId,
        data: {
          name: editName.trim(),
          ...(isYtLinked ? {} : { mode: editMode }),
        },
      },
      {
        onSuccess: () => {
          toast.success('Playlist updated');
          if (modeChanging && (detail?.songs?.length ?? 0) > 0) {
            toast.message('Mode changed — remove songs that no longer match the new mode if needed');
          }
          setShowEdit(false);
        },
        onError: (err: any) => toast.error(err?.response?.data?.error || 'Failed to update playlist'),
      },
    );
  };

  const handleAddLoadUrl = () => {
    if (!addYtUrl.trim() || !selectedConfigId) return;
    ytInfo.mutate(
      { configId: selectedConfigId, url: addYtUrl.trim() },
      {
        onSuccess: (data: UrlLoadInfo) => {
          setAddUrlInfo(data);
          if (data.type === 'playlist') {
            setAddSelectedUrlIds(allUrlItemKeys(data.items.length));
          }
        },
        onError: (err: unknown) => toast.error(youtubeInfoErrorMessage(err)),
      },
    );
  };

  const toggleAddUrlSelect = (index: number) => {
    const key = urlItemSelectKey(index);
    setAddSelectedUrlIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleAddSingleDownload = (item: { id: string; title?: string; artist?: string; duration?: number }) => {
    if (!selectedConfigId || !selectedId) return;
    const url = `https://www.youtube.com/watch?v=${item.id}`;

    // Stream playlists: register URL only (download on play). Local: download now.
    if (playlistMode === 'stream') {
      ytRegister.mutate(
        {
          configId: selectedConfigId,
          items: [{ url, title: item.title, artist: item.artist, duration: item.duration }],
        },
        {
          onSuccess: async (data: any) => {
            const song = Array.isArray(data?.results) ? data.results[0] : null;
            if (!song?.id) {
              toast.error('Failed to register track');
              return;
            }
            addSong.mutate(
              { playlistId: selectedId, songId: song.id },
              {
                onSuccess: () => toast.success('Added to stream playlist (on-demand)'),
                onError: (err: any) => toast.error(err?.response?.data?.error || 'Failed to add song'),
              },
            );
            setAddUrlInfo(null);
            setAddYtUrl('');
          },
          onError: (err: any) => toast.error(err?.response?.data?.error || 'Failed to register track'),
        },
      );
      return;
    }

    ytDownload.mutate(
      { configId: selectedConfigId, url },
      {
        onSuccess: (song: any) => {
          addSong.mutate(
            { playlistId: selectedId, songId: song.id },
            {
              onSuccess: () => toast.success('Added to playlist'),
              onError: (err: any) => toast.error(err?.response?.data?.error || 'Failed to add song'),
            },
          );
          setAddUrlInfo(null);
          setAddYtUrl('');
        },
        onError: () => toast.error('Download failed'),
      },
    );
  };

  const handleAddBatchDownload = () => {
    if (!selectedConfigId || !selectedId || !addUrlInfo) return;
    const selectedItems = selectedUrlItems(addUrlInfo.items, addSelectedUrlIds);
    if (selectedItems.length === 0) return;

    if (playlistMode === 'stream') {
      setAddBatchProgress(`Registering 0/${selectedItems.length}...`);
      ytRegister.mutate(
        {
          configId: selectedConfigId,
          items: selectedItems.map((i) => ({
            url: `https://www.youtube.com/watch?v=${i.id}`,
            title: i.title,
            artist: i.artist,
            duration: i.duration,
          })),
        },
        {
          onSuccess: async (data: any) => {
            setAddBatchProgress(null);
            const results = Array.isArray(data?.results) ? data.results : [];
            let added = 0;
            for (const song of results) {
              if (!song?.id || playlistSongIds.has(song.id)) continue;
              try {
                await addSong.mutateAsync({ playlistId: selectedId, songId: song.id });
                added++;
              } catch {
                /* skip */
              }
            }
            toast.success(
              added > 0
                ? `Added ${added} stream track${added === 1 ? '' : 's'} (download on play)`
                : 'Nothing new to add',
            );
            if (data.errors?.length) toast.error(`${data.errors.length} failed`);
            resetAddUrlState();
          },
          onError: (err: any) => {
            setAddBatchProgress(null);
            toast.error(err?.response?.data?.error || 'Failed to register tracks');
          },
        },
      );
      return;
    }

    const urls = selectedItems.map((i: any) => `https://www.youtube.com/watch?v=${i.id}`);
    setAddBatchProgress('Preparing download…');
    ytBatchDownload.mutate(
      { configId: selectedConfigId, urls },
      {
        onSuccess: async (data: any) => {
          setAddBatchProgress(null);
          const results = Array.isArray(data?.results) ? data.results : [];
          let added = 0;
          for (const song of results) {
            if (!song?.id || playlistSongIds.has(song.id)) continue;
            try {
              await addSong.mutateAsync({ playlistId: selectedId, songId: song.id });
              added++;
            } catch {
              // skip duplicates / mode mismatches
            }
          }
          toast.success(
            added > 0
              ? `Added ${added} song${added === 1 ? '' : 's'} from URL`
              : `Downloaded ${data.downloaded ?? 0}/${data.total ?? 0} — nothing new to add`,
          );
          if (data.errors?.length) toast.error(`${data.errors.length} failed`);
          resetAddUrlState();
        },
        onError: () => {
          setAddBatchProgress(null);
          toast.error('Batch download failed');
        },
      },
    );
  };

  const handleAddImportPlaylist = (reimport = false, queueOnly = false) => {
    if (!selectedConfigId || !addYtUrl.trim()) return;
    if (queueOnly && !importQueueBotId) {
      toast.error('Select a running media bot to import to its queue');
      return;
    }
    const musicBotId = importQueueBotId ? parseInt(importQueueBotId, 10) : undefined;
    ytImportPlaylist.mutate(
      {
        configId: selectedConfigId,
        url: addYtUrl.trim(),
        ...(queueOnly ? {} : { playlistId: selectedId! }),
        reimport,
        ...(musicBotId ? { musicBotId, clearFirst: importClearQueue } : {}),
      },
      {
        onSuccess: (data: any) => {
          setAddImportJobId(data.jobId);
          toast.success(queueOnly ? 'Queue import started' : 'Playlist import started', {
            description: importCapHint(maxPlaylistImport),
          });
        },
        onError: (err: any) => toast.error(err?.response?.data?.error || 'Failed to start playlist import'),
      },
    );
  };

  useEffect(() => {
    if (addImportJob?.status === 'completed') {
      toast.success(importJobCompleteMessage(addImportJob));
      qc.invalidateQueries({ queryKey: ['songs', selectedConfigId] });
      qc.invalidateQueries({ queryKey: ['playlist', selectedId] });
      qc.invalidateQueries({ queryKey: ['playlists'] });
      if (addImportJob.musicBotId) {
        qc.invalidateQueries({ queryKey: ['music-bot', addImportJob.musicBotId] });
        qc.invalidateQueries({ queryKey: ['music-bot-state', addImportJob.musicBotId] });
      }
      resetAddUrlState();
    } else if (addImportJob?.status === 'failed') {
      toast.error(addImportJob.errors?.[0] || 'Playlist import failed');
      setAddImportJobId(null);
    }
  }, [addImportJob?.status, selectedConfigId, selectedId, qc, addImportJob]);

  if (isLoading) return <PageLoader />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {playlists.length} playlist{playlists.length !== 1 ? 's' : ''}
        </p>
        <Button
          size="sm"
          onClick={() => {
            setNewName('');
            setNewMode('local');
            setShowCreate(true);
          }}
        >
          <Plus className="h-4 w-4 mr-1" /> New Playlist
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        <div className="space-y-1.5">
          {playlists.length === 0 ? (
            <EmptyState
              icon={ListMusic}
              title="No playlists"
              description="Create a local or stream playlist to organize your songs."
            />
          ) : (
            playlists.map((pl) => (
              <div
                key={pl.id}
                className={`flex items-center gap-2 p-2.5 rounded-md cursor-pointer transition-colors ${
                  selectedId === pl.id
                    ? 'bg-primary/10 border border-primary/30'
                    : 'hover:bg-muted/50 border border-transparent'
                }`}
                onClick={() => setSelectedId(pl.id)}
              >
                <ListMusic
                  className={`h-4 w-4 shrink-0 ${selectedId === pl.id ? 'text-primary' : 'text-muted-foreground'}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{pl.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Badge variant="outline" className="text-[9px] h-4 px-1">
                      {pl.mode === 'stream' ? 'stream' : 'local'}
                    </Badge>
                    <p className="text-[10px] text-muted-foreground">
                      {pl.songCount} song{pl.songCount !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive hover:text-destructive shrink-0"
                  aria-label={`Delete playlist ${pl.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteId(pl.id);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))
          )}
        </div>

        {selectedId && detail ? (
          <Card>
            <CardHeader className="py-3 px-4">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle className="text-sm truncate">{detail.name}</CardTitle>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {playlistMode === 'local'
                      ? 'Local only — library uploads / scanned local files'
                      : 'Stream only — YouTube / URL tracks'}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={openEdit}>
                    <Pencil className="h-3 w-3 mr-1" /> Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      setAddTab(playlistMode === 'stream' ? 'url' : 'songs');
                      setSongFilter('');
                      resetAddUrlState();
                      setShowAddSong(true);
                    }}
                  >
                    <Plus className="h-3 w-3 mr-1" /> Add Songs
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {detail.songs.length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  No songs in this playlist
                </div>
              ) : (
                <div className="max-h-[400px] overflow-y-auto">
                  {detail.songs.map((song: any, i: number) => (
                    <div
                      key={song.id}
                      className="flex items-center gap-2 px-4 py-2 hover:bg-muted/30 transition-colors border-t border-border/50"
                    >
                      <span className="text-[10px] text-muted-foreground w-5 text-right">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium truncate">{song.title}</p>
                        {song.artist && (
                          <p className="text-[10px] text-muted-foreground truncate">{song.artist}</p>
                        )}
                      </div>
                      <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0">
                        {song.source}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">{formatTime(song.duration)}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive hover:text-destructive"
                        aria-label={`Remove ${song.title} from playlist`}
                        onClick={() =>
                          removeSong.mutate(
                            { playlistId: selectedId, songId: song.id },
                            { onSuccess: () => toast.success('Song removed') },
                          )
                        }
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="flex items-center justify-center text-xs text-muted-foreground py-16">
            Select a playlist to view its songs
          </div>
        )}
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Playlist</DialogTitle>
            <DialogDescription>
              Local playlists hold uploaded/scanned files. Stream playlists hold YouTube / URL tracks.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Name</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="My Playlist"
                onKeyDown={(e) => e.key === 'Enter' && newName && handleCreate()}
              />
            </div>
            <div>
              <Label className="text-xs">Mode</Label>
              <Select value={newMode} onValueChange={(v) => setNewMode(v as PlaylistMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">Local only</SelectItem>
                  <SelectItem value="stream">Stream only</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!newName || createPlaylist.isPending}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Playlist</DialogTitle>
            <DialogDescription>
              Rename this playlist or change whether it holds local or stream tracks.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Name</Label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="My Playlist"
                onKeyDown={(e) => e.key === 'Enter' && editName.trim() && handleEditSave()}
              />
            </div>
            <div>
              <Label className="text-xs">Mode</Label>
              <Select
                value={editMode}
                onValueChange={(v) => setEditMode(v as PlaylistMode)}
                disabled={isYtLinked}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">Local only</SelectItem>
                  <SelectItem value="stream">Stream only</SelectItem>
                </SelectContent>
              </Select>
              {isYtLinked && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  YouTube-imported playlists stay in stream mode.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEdit(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleEditSave}
              disabled={!editName.trim() || updatePlaylist.isPending}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showAddSong}
        onOpenChange={(open) => {
          setShowAddSong(open);
          if (!open) {
            setSongFilter('');
            setAddTab('songs');
            resetAddUrlState();
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add to {detail?.name || 'playlist'}</DialogTitle>
            <DialogDescription>
              {playlistMode === 'local'
                ? 'Add local library songs, or copy matching songs from another playlist.'
                : 'Add via URL (saved for on-demand play — no download until played), pick stream library tracks, or copy from another playlist.'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant={addTab === 'songs' ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setAddTab('songs')}
            >
              <FileAudio className="h-3 w-3 mr-1" /> Songs
            </Button>
            <Button
              variant={addTab === 'playlists' ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setAddTab('playlists')}
            >
              <ListMusic className="h-3 w-3 mr-1" /> From playlist
            </Button>
            {playlistMode === 'stream' && (
              <Button
                variant={addTab === 'url' ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setAddTab('url')}
              >
                <Link className="h-3 w-3 mr-1" /> URL
              </Button>
            )}
          </div>

          {addTab === 'songs' ? (
            <>
              <Input
                value={songFilter}
                onChange={(e) => setSongFilter(e.target.value)}
                placeholder="Filter songs..."
              />
              <ScrollArea className="max-h-72">
                {availableSongs.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-8">
                    No matching {playlistMode === 'local' ? 'local' : 'stream'} songs available.
                  </p>
                ) : (
                  availableSongs.map((song) => (
                    <div
                      key={song.id}
                      className="flex items-center gap-2 py-1.5 hover:bg-muted/30 transition-colors rounded px-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-xs truncate">{song.title}</p>
                        {song.artist && (
                          <p className="text-[10px] text-muted-foreground truncate">{song.artist}</p>
                        )}
                      </div>
                      <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0">
                        {song.source}
                      </Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[10px] shrink-0"
                        onClick={() => {
                          if (selectedId)
                            addSong.mutate(
                              { playlistId: selectedId, songId: song.id },
                              {
                                onSuccess: () => toast.success('Song added'),
                                onError: (err: any) =>
                                  toast.error(err?.response?.data?.error || 'Failed to add song'),
                              },
                            );
                        }}
                      >
                        <Plus className="h-3 w-3 mr-0.5" /> Add
                      </Button>
                    </div>
                  ))
                )}
              </ScrollArea>
            </>
          ) : addTab === 'playlists' ? (
            <ScrollArea className="max-h-72">
              {otherPlaylists.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">
                  No other playlists to import from.
                </p>
              ) : (
                otherPlaylists.map((pl) => (
                  <div
                    key={pl.id}
                    className="flex items-center gap-2 py-1.5 hover:bg-muted/30 transition-colors rounded px-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{pl.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {pl.songCount} song{pl.songCount !== 1 ? 's' : ''} · {pl.mode === 'stream' ? 'stream' : 'local'}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px] shrink-0"
                      disabled={addFromPlaylist.isPending}
                      onClick={() => {
                        if (!selectedId) return;
                        addFromPlaylist.mutate(
                          { playlistId: selectedId, sourcePlaylistId: pl.id },
                          {
                            onSuccess: (res: any) => {
                              const added = res?.added ?? 0;
                              toast.success(
                                added > 0
                                  ? `Added ${added} song${added === 1 ? '' : 's'} from “${pl.name}”`
                                  : 'No new matching songs to add',
                              );
                            },
                            onError: (err: any) =>
                              toast.error(err?.response?.data?.error || 'Failed to import playlist'),
                          },
                        );
                      }}
                    >
                      <Plus className="h-3 w-3 mr-0.5" /> Add all matching
                    </Button>
                  </div>
                ))
              )}
            </ScrollArea>
          ) : (
            <div className="space-y-3">
              {!selectedConfigId ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                  Select a server in the sidebar to import from YouTube.
                </p>
              ) : (
                <>
                  <ImportQueueOptions
                    bots={playlistMusicBots}
                    configId={selectedConfigId}
                    botId={importQueueBotId}
                    onBotIdChange={setImportQueueBotId}
                    clearFirst={importClearQueue}
                    onClearFirstChange={setImportClearQueue}
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    {(ytDownload.progress || ytBatchDownload.progress) && (
                      <p role="status" className="w-full text-xs text-muted-foreground">{ytDownload.isPending ? ytDownload.progress : ytBatchDownload.isPending ? ytBatchDownload.progress : ytDownload.progress || ytBatchDownload.progress}</p>
                    )}
                    <div className="relative flex-1">
                      <Link className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                      <Input
                        value={addYtUrl}
                        onChange={(e) => setAddYtUrl(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddLoadUrl()}
                        placeholder="Paste YouTube, Apple Music, or Playlist URL..."
                        className="pl-9"
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleAddLoadUrl}
                      disabled={ytInfo.isPending || !addYtUrl.trim()}
                    >
                      {ytInfo.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Youtube className="h-4 w-4 mr-1" />
                      )}
                      Load
                    </Button>
                    {ytInfo.isPending && (
                      <span className="text-[10px] text-muted-foreground">
                        Large Apple Music playlists can take 1–2 minutes
                      </span>
                    )}
                    {addYtUrl.trim() && !addUrlInfo && (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleAddImportPlaylist(false)}
                          disabled={ytImportPlaylist.isPending || !!addImportJobId || !selectedId}
                        >
                          {addImportJobId ? (
                            <>
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                              {importJobProgressLabel(addImportJob)}
                            </>
                          ) : (
                            <>
                              <ListMusic className="h-3 w-3 mr-1" /> Import all
                            </>
                          )}
                        </Button>
                        {importQueueBotId && (
                          <Button
                            variant="default"
                            size="sm"
                            onClick={() => handleAddImportPlaylist(false, true)}
                            disabled={ytImportPlaylist.isPending || !!addImportJobId}
                          >
                            <ListMusic className="h-3 w-3 mr-1" /> Import to queue
                          </Button>
                        )}
                      </>
                    )}
                  </div>

                  {addUrlInfo && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <Badge variant="secondary" className="text-xs">
                          {urlInfoPlaylistLabel(addUrlInfo)}
                        </Badge>
                        {addUrlInfo.type === 'playlist' && (
                          <div className="flex items-center gap-2 flex-wrap">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 text-[10px]"
                              onClick={() =>
                                setAddSelectedUrlIds(allUrlItemKeys(addUrlInfo.items.length))
                              }
                            >
                              Select All
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 text-[10px]"
                              onClick={() => setAddSelectedUrlIds(new Set())}
                            >
                              Deselect All
                            </Button>
                            <Button
                              variant="default"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={handleAddBatchDownload}
                              disabled={
                                addSelectedUrlIds.size === 0 ||
                                ytBatchDownload.isPending ||
                                ytRegister.isPending
                              }
                            >
                              {ytBatchDownload.isPending || ytRegister.isPending ? (
                                <>
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />{' '}
                                  {ytBatchDownload.progress || addBatchProgress || (playlistMode === 'stream' ? 'Adding...' : 'Downloading...')}
                                </>
                              ) : (
                                <>
                                  <Plus className="h-3 w-3 mr-1" /> Add {addSelectedUrlIds.size}{' '}
                                  Selected
                                </>
                              )}
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => handleAddImportPlaylist(false)}
                              disabled={ytImportPlaylist.isPending || !!addImportJobId}
                            >
                              {addImportJobId ? (
                                <>
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                  {importJobProgressLabel(addImportJob)}
                                </>
                              ) : (
                                <>
                                  <ListMusic className="h-3 w-3 mr-1" /> Import all
                                </>
                              )}
                            </Button>
                          </div>
                        )}
                      </div>
                      <ScrollArea className="max-h-60">
                        {addUrlInfo.items.map((item, index) => (
                          <div
                            key={`${item.id}-${index}`}
                            className={`flex items-center gap-3 px-2 py-1.5 rounded transition-colors ${
                              addUrlInfo.type === 'playlist'
                                ? `cursor-pointer ${addSelectedUrlIds.has(urlItemSelectKey(index)) ? 'bg-primary/10' : 'hover:bg-muted/50'}`
                                : 'hover:bg-muted/50'
                            }`}
                            onClick={() =>
                              addUrlInfo.type === 'playlist' && toggleAddUrlSelect(index)
                            }
                          >
                            {addUrlInfo.type === 'playlist' && (
                              <input
                                type="checkbox"
                                checked={addSelectedUrlIds.has(urlItemSelectKey(index))}
                                onClick={(e) => e.stopPropagation()}
                                onChange={() => toggleAddUrlSelect(index)}
                                className="shrink-0 accent-primary"
                              />
                            )}
                            {item.thumbnail && (
                              <img
                                src={item.thumbnail}
                                alt=""
                                className="h-8 w-12 rounded object-cover shrink-0"
                              />
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium truncate">{item.title}</p>
                              <p className="text-[10px] text-muted-foreground">
                                {item.artist} - {formatTime(item.duration)}
                              </p>
                            </div>
                            {addUrlInfo.type === 'video' && (
                              <Button
                                variant="default"
                                size="sm"
                                className="h-7 text-xs shrink-0"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleAddSingleDownload(item);
                                }}
                                disabled={ytDownload.isPending || ytRegister.isPending}
                              >
                                {ytDownload.isPending || ytRegister.isPending ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <>
                                    <Plus className="h-3 w-3 mr-1" /> Add
                                  </>
                                )}
                              </Button>
                            )}
                          </div>
                        ))}
                      </ScrollArea>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowAddSong(false);
                setSongFilter('');
                resetAddUrlState();
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Playlist?"
        description="This will permanently delete this playlist."
        onConfirm={() => {
          if (deleteId)
            deletePlaylist.mutate(deleteId, {
              onSuccess: () => {
                toast.success('Playlist deleted');
                if (selectedId === deleteId) setSelectedId(null);
                setDeleteId(null);
              },
            });
        }}
        destructive
      />
    </div>
  );
}

