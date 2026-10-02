import { useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMusicBots } from '@/hooks/use-music-bots';
import {
  useSongs,
  useUploadSong,
  useDeleteSong,
  useYouTubeSearch,
  useYouTubeDownload,
  useYouTubeInfo,
  useYouTubeDownloadBatch,
  useScanLibrary,
  useYouTubeImportPlaylist,
  useYouTubeImportStatus,
} from '@/hooks/use-music-library';
import { useServers } from '@/hooks/use-servers';
import { useServerStore } from '@/stores/server.store';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
  Trash2,
  Upload,
  Search,
  Download,
  ListMusic,
  X,
  Loader2,
  Youtube,
  FileAudio,
  Link,
} from 'lucide-react';
import { RuntimeMediaDiagnostics } from '@/components/media/RuntimeMediaDiagnostics';
import { toast } from 'sonner';
import { formatBytes } from '@/lib/utils';
import type { MusicBotSummary, SongInfo, YouTubeSearchResult } from '@ts6/common';
import { settingsApi } from '@/api/settings.api';
import { formatTime, UrlLoadInfo, youtubeInfoErrorMessage, urlInfoPlaylistLabel, urlItemSelectKey, allUrlItemKeys, selectedUrlItems, importJobProgressLabel, importJobCompleteMessage, importCapHint } from './shared';
import { ImportQueueOptions } from './ImportQueueOptions';


// ─── Library Tab ─────────────────────────────────────────────────────────────

export function LibraryTab() {
  const qc = useQueryClient();
  const { selectedConfigId } = useServerStore();
  const { data: servers } = useServers();
  const [libServerId, setLibServerId] = useState<number | null>(selectedConfigId);
  const configId = libServerId || selectedConfigId;

  const { data: songs, isLoading } = useSongs(configId);
  const uploadSong = useUploadSong();
  const scanLibrary = useScanLibrary();
  const deleteSong = useDeleteSong();
  const ytSearch = useYouTubeSearch();
  const ytDownload = useYouTubeDownload();

  const ytInfo = useYouTubeInfo();
  const ytBatchDownload = useYouTubeDownloadBatch();
  const ytImportPlaylist = useYouTubeImportPlaylist();
  const { data: importLimits } = useQuery({
    queryKey: ['settings-limits'],
    queryFn: settingsApi.getLimits,
    staleTime: 60_000,
  });
  const maxPlaylistImport = importLimits?.maxPlaylistImport ?? 250;
  const { data: musicBotsData } = useMusicBots();
  const musicBots = (Array.isArray(musicBotsData) ? musicBotsData : []) as MusicBotSummary[];

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [ytResults, setYtResults] = useState<YouTubeSearchResult[]>([]);
  const [showYt, setShowYt] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [ytUrl, setYtUrl] = useState('');
  const [urlInfo, setUrlInfo] = useState<UrlLoadInfo | null>(null);
  const [selectedUrlIds, setSelectedUrlIds] = useState<Set<string>>(new Set());
  const [batchProgress, setBatchProgress] = useState<string | null>(null);
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const [importPlaylistName, setImportPlaylistName] = useState('');
  const [importQueueBotId, setImportQueueBotId] = useState('');
  const [importClearQueue, setImportClearQueue] = useState(false);
  const { data: importJob } = useYouTubeImportStatus(configId, importJobId);

  const serverList = Array.isArray(servers) ? servers : [];
  const songList = (Array.isArray(songs) ? songs : []) as SongInfo[];
  const filtered = filter
    ? songList.filter((s) => s.title.toLowerCase().includes(filter.toLowerCase()) || (s.artist || '').toLowerCase().includes(filter.toLowerCase()))
    : songList;

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !configId) return;
    Array.from(files).forEach((file) => {
      const formData = new FormData();
      formData.append('file', file);
      uploadSong.mutate({ configId, formData }, {
        onSuccess: () => toast.success(`Uploaded: ${file.name}`),
        onError: () => toast.error(`Failed to upload: ${file.name}`),
      });
    });
    e.target.value = '';
  };

  const handleYtSearch = () => {
    if (!searchQuery.trim() || !configId) return;
    ytSearch.mutate({ configId, query: searchQuery }, {
      onSuccess: (data: any) => {
        setYtResults(Array.isArray(data) ? data : data?.results || []);
        setShowYt(true);
      },
      onError: () => toast.error('YouTube search failed'),
    });
  };

  const handleYtDownload = (url: string) => {
    if (!configId) return;
    ytDownload.mutate({ configId, url }, {
      onSuccess: () => toast.success('Download complete'),
      onError: () => toast.error('Download failed'),
    });
  };

  const sourceIcon = (source: string) => {
    switch (source) {
      case 'youtube': return <Youtube className="h-3 w-3" />;
      case 'url': return <Link className="h-3 w-3" />;
      default: return <FileAudio className="h-3 w-3" />;
    }
  };

  const handleLoadUrl = () => {
    if (!ytUrl.trim() || !configId) return;
    ytInfo.mutate({ configId, url: ytUrl }, {
      onSuccess: (data: UrlLoadInfo) => {
        setUrlInfo(data);
        if (data.type === 'playlist') {
          setSelectedUrlIds(allUrlItemKeys(data.items.length));
        }
      },
      onError: (err: unknown) => toast.error(youtubeInfoErrorMessage(err)),
    });
  };

  const handleBatchDownload = () => {
    if (!configId || !urlInfo) return;
    const selected = selectedUrlItems(urlInfo.items, selectedUrlIds);
    const urls = selected.map((item) => `https://www.youtube.com/watch?v=${item.id}`);
    setBatchProgress('Preparing download…');
    ytBatchDownload.mutate({ configId, urls }, {
      onSuccess: (data: any) => {
        setBatchProgress(null);
        toast.success(`Downloaded ${data.downloaded}/${data.total} songs`);
        if (data.errors?.length) toast.error(`${data.errors.length} failed`);
        setUrlInfo(null);
        setYtUrl('');
      },
      onError: () => { setBatchProgress(null); toast.error('Batch download failed'); },
    });
  };

  const toggleUrlSelect = (index: number) => {
    const key = urlItemSelectKey(index);
    setSelectedUrlIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleImportPlaylist = (reimport = false, queueOnly = false) => {
    if (!configId || !ytUrl.trim()) return;
    if (queueOnly && !importQueueBotId) {
      toast.error('Select a running media bot to import to its queue');
      return;
    }
    const musicBotId = importQueueBotId ? parseInt(importQueueBotId, 10) : undefined;
    ytImportPlaylist.mutate({
      configId,
      url: ytUrl.trim(),
      ...(queueOnly
        ? {}
        : {
            playlistName: importPlaylistName.trim() || urlInfo?.title,
          }),
      reimport,
      ...(musicBotId
        ? { musicBotId, clearFirst: importClearQueue }
        : {}),
    }, {
      onSuccess: (data: any) => {
        setImportJobId(data.jobId);
        toast.success(queueOnly ? 'Queue import started' : 'Playlist import started', {
          description: importCapHint(maxPlaylistImport),
        });
      },
      onError: (err: any) =>
        toast.error(err?.response?.data?.error || 'Failed to start playlist import'),
    });
  };

  useEffect(() => {
    if (importJob?.status === 'completed') {
      toast.success(importJobCompleteMessage(importJob));
      qc.invalidateQueries({ queryKey: ['songs', configId] });
      qc.invalidateQueries({ queryKey: ['playlists'] });
      if (importJob.musicBotId) {
        qc.invalidateQueries({ queryKey: ['music-bot', importJob.musicBotId] });
        qc.invalidateQueries({ queryKey: ['music-bot-state', importJob.musicBotId] });
      }
      setImportJobId(null);
      setUrlInfo(null);
      setYtUrl('');
    } else if (importJob?.status === 'failed') {
      toast.error(importJob.errors[0] || 'Playlist import failed');
      setImportJobId(null);
    }
  }, [importJob?.status, configId, qc, importJob]);

  if (!configId) {
    return <EmptyState icon={Music} title="Select a server" description="Choose a server to manage its music library." />;
  }

  return (
    <div className="space-y-4">
      <RuntimeMediaDiagnostics focus={['yt-dlp', 'ffmpeg', 'ffprobe']} />
      {/* Server selector + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={String(configId)} onValueChange={(v) => setLibServerId(parseInt(v))}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Server..." /></SelectTrigger>
          <SelectContent>
            {serverList.map((s: any) => (
              <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter songs..."
          className="w-48"
        />
        <input ref={fileInputRef} type="file" accept="audio/*" multiple hidden onChange={handleUpload} />
        <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadSong.isPending}>
          <Upload className="h-4 w-4 mr-1" /> {uploadSong.isPending ? 'Uploading...' : 'Upload'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!configId || scanLibrary.isPending}
          onClick={() => {
            if (!configId) return;
            scanLibrary.mutate(configId, {
              onSuccess: (data: any) => {
                const imported = data?.imported ?? 0;
                const updated = data?.updated ?? 0;
                if (imported === 0 && updated === 0) {
                  toast.success('Scan complete — nothing new');
                } else {
                  const parts = [];
                  if (imported) parts.push(`imported ${imported}`);
                  if (updated) parts.push(`updated ${updated} YouTube file(s)`);
                  toast.success(`Scan complete — ${parts.join(', ')}`);
                }
              },
              onError: () => toast.error('Library scan failed'),
            });
          }}
        >
          <Search className="h-4 w-4 mr-1" /> {scanLibrary.isPending ? 'Scanning...' : 'Scan folder'}
        </Button>
      </div>

      {/* YouTube URL / Playlist Paste */}
      <Card className="border-dashed">
        <CardContent className="p-3 space-y-3">
          <p className="text-[10px] text-muted-foreground">{importCapHint(maxPlaylistImport)}</p>
          <ImportQueueOptions
            bots={musicBots}
            configId={configId}
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
                value={ytUrl}
                onChange={(e) => setYtUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLoadUrl()}
                placeholder="Paste YouTube, Apple Music, or Playlist URL..."
                className="pl-9"
              />
            </div>
            <Button variant="outline" size="sm" onClick={handleLoadUrl} disabled={ytInfo.isPending || !ytUrl.trim()}>
              {ytInfo.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Youtube className="h-4 w-4 mr-1" />}
              Load
            </Button>
            {ytInfo.isPending && (
              <span className="text-[10px] text-muted-foreground">Large Apple Music playlists can take 1–2 minutes</span>
            )}
            {ytUrl.trim() && !urlInfo && (
              <>
                <Input
                  className="h-8 w-40 text-xs"
                  placeholder="Playlist name (optional)"
                  value={importPlaylistName}
                  onChange={(e) => setImportPlaylistName(e.target.value)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleImportPlaylist(false)}
                  disabled={ytImportPlaylist.isPending || !!importJobId}
                >
                  {importJobId ? (
                    <>
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      {importJobProgressLabel(importJob)}
                    </>
                  ) : (
                    <>
                      <ListMusic className="h-3 w-3 mr-1" /> Import as Playlist
                    </>
                  )}
                </Button>
                {importQueueBotId && (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => handleImportPlaylist(false, true)}
                    disabled={ytImportPlaylist.isPending || !!importJobId}
                  >
                    <ListMusic className="h-3 w-3 mr-1" /> Import to queue
                  </Button>
                )}
              </>
            )}
            {urlInfo && (
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Clear URL details" onClick={() => { setUrlInfo(null); setYtUrl(''); }}>
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* URL Info Results */}
          {urlInfo && (
            <div className="space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <Badge variant="secondary" className="text-xs">
                  {urlInfoPlaylistLabel(urlInfo)}
                </Badge>
                {urlInfo.type === 'playlist' && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button variant="ghost" size="sm" className="h-6 text-[10px]"
                      onClick={() => setSelectedUrlIds(allUrlItemKeys(urlInfo.items.length))}
                    >
                      Select All
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 text-[10px]"
                      onClick={() => setSelectedUrlIds(new Set())}
                    >
                      Deselect All
                    </Button>
                    <Button variant="default" size="sm" className="h-7 text-xs"
                      onClick={handleBatchDownload}
                      disabled={selectedUrlIds.size === 0 || ytBatchDownload.isPending}
                    >
                      {ytBatchDownload.isPending ? (
                        <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> {ytBatchDownload.progress || batchProgress || 'Downloading...'}</>
                      ) : (
                        <><Download className="h-3 w-3 mr-1" /> Download {selectedUrlIds.size} Selected</>
                      )}
                    </Button>
                    <Input
                      className="h-7 w-40 text-xs"
                      placeholder="Playlist name (optional)"
                      value={importPlaylistName}
                      onChange={(e) => setImportPlaylistName(e.target.value)}
                    />
                    <Button variant="secondary" size="sm" className="h-7 text-xs"
                      onClick={() => handleImportPlaylist(false)}
                      disabled={ytImportPlaylist.isPending || !!importJobId}
                    >
                      {importJobId ? (
                        <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> {importJobProgressLabel(importJob)}</>
                      ) : (
                        <><ListMusic className="h-3 w-3 mr-1" /> Import as Playlist</>
                      )}
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs"
                      onClick={() => handleImportPlaylist(true)}
                      disabled={ytImportPlaylist.isPending || !!importJobId}
                      title="Re-import adds missing tracks and re-links existing downloads"
                    >
                      Re-import
                    </Button>
                  </div>
                )}
              </div>
              <ScrollArea className="max-h-60">
                {urlInfo.items.map((item, index) => (
                  <div
                    key={`${item.id}-${index}`}
                    className={`flex items-center gap-3 px-2 py-1.5 rounded transition-colors ${
                      urlInfo.type === 'playlist'
                        ? `cursor-pointer ${selectedUrlIds.has(urlItemSelectKey(index)) ? 'bg-primary/10' : 'hover:bg-muted/50'}`
                        : 'hover:bg-muted/50'
                    }`}
                    onClick={() => urlInfo.type === 'playlist' && toggleUrlSelect(index)}
                  >
                    {urlInfo.type === 'playlist' && (
                      <input
                        type="checkbox"
                        checked={selectedUrlIds.has(urlItemSelectKey(index))}
                        onChange={() => toggleUrlSelect(index)}
                        className="shrink-0 accent-primary"
                      />
                    )}
                    {item.thumbnail && (
                      <img src={item.thumbnail} alt="" className="h-8 w-12 rounded object-cover shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{item.title}</p>
                      <p className="text-[10px] text-muted-foreground">{item.artist} - {formatTime(item.duration)}</p>
                    </div>
                    {urlInfo.type === 'video' && (
                      <Button variant="default" size="sm" className="h-7 text-xs shrink-0"
                        onClick={(e) => { e.stopPropagation(); handleYtDownload(`https://www.youtube.com/watch?v=${item.id}`); }}
                        disabled={ytDownload.isPending}
                      >
                        <Download className="h-3 w-3 mr-1" /> Download
                      </Button>
                    )}
                  </div>
                ))}
              </ScrollArea>
            </div>
          )}
        </CardContent>
      </Card>

      {/* YouTube Search */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleYtSearch()}
            placeholder="Search YouTube..."
            className="pl-9"
          />
        </div>
        <Button variant="outline" size="sm" onClick={handleYtSearch} disabled={ytSearch.isPending || !searchQuery.trim()}>
          {ytSearch.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Youtube className="h-4 w-4 mr-1" />}
          Search
        </Button>
      </div>

      {/* YouTube Results */}
      {showYt && ytResults.length > 0 && (
        <Card>
          <CardHeader className="py-2 px-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs">YouTube Results ({ytResults.length})</CardTitle>
              <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Close YouTube results" onClick={() => setShowYt(false)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-60 overflow-y-auto">
              {ytResults.map((r) => (
                <div key={r.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 transition-colors">
                  {r.thumbnail && (
                    <img src={r.thumbnail} alt="" className="h-10 w-14 rounded object-cover shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{r.title}</p>
                    <p className="text-[10px] text-muted-foreground">{r.artist} - {formatTime(r.duration)}</p>
                  </div>
                  <Button variant="outline" size="sm" className="h-7 text-xs shrink-0"
                    onClick={() => handleYtDownload(`https://www.youtube.com/watch?v=${r.id}`)}
                    disabled={ytDownload.isPending}
                  >
                    <Download className="h-3 w-3 mr-1" /> Download
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Song List */}
      {isLoading ? <PageLoader /> : filtered.length === 0 ? (
        <EmptyState icon={Music} title="No songs yet" description="Upload audio files or download from YouTube to build your library." />
      ) : (
        <div className="max-w-full overflow-x-auto rounded-lg border">
          <div className="grid min-w-[38rem] grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] gap-2 bg-muted/50 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <span>Title</span>
            <span className="w-20 text-right">Duration</span>
            <span className="w-16 text-center">Source</span>
            <span className="w-16 text-right">Size</span>
            <span className="w-16" />
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {filtered.map((song) => (
              <div key={song.id} className="grid min-w-[38rem] grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-2 border-t border-border/50 px-3 py-2 transition-colors hover:bg-muted/30">
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{song.title}</p>
                  {song.artist && <p className="text-[10px] text-muted-foreground truncate">{song.artist}</p>}
                </div>
                <span className="text-xs text-muted-foreground w-20 text-right">{formatTime(song.duration)}</span>
                <span className="w-16 flex justify-center">
                  <Badge variant="outline" className="text-[9px] gap-1">{sourceIcon(song.source)} {song.source}</Badge>
                </span>
                <span className="text-xs text-muted-foreground w-16 text-right">{song.fileSize ? formatBytes(song.fileSize) : '-'}</span>
                <div className="w-16 flex justify-end">
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive"
                    aria-label={`Delete ${song.title}`}
                    onClick={() => setDeleteId(song.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Song?"
        description="This will permanently remove this song from the library."
        onConfirm={() => {
          if (deleteId && configId) deleteSong.mutate({ configId, songId: deleteId }, {
            onSuccess: () => { toast.success('Song deleted'); setDeleteId(null); },
          });
        }}
        destructive
      />
    </div>
  );
}

