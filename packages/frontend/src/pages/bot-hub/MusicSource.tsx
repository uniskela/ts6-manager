/**
 * Console Music tab: Songs · Playlists · Recent requests, each with search and pager.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ListMusic, Play, Plus } from 'lucide-react';
import type { PlaylistSummary, SongInfo } from '@ts6/common';
import { musicRequestsApi } from '@/api/music-requests.api';
import { Pager } from '@/components/shared/Pager';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSongSearch } from '@/hooks/use-music-library';
import { useEnqueue, useLoadPlaylist, usePlaySong, usePlayUrl } from '@/hooks/use-music-bots';
import { usePlaylists } from '@/hooks/use-playlists';
import { apiErrorMessage } from '@/lib/api-error';
import { pageSlice, rememberedPageSize, type PageSize } from '@/lib/pager';
import { cn } from '@/lib/utils';
import { formatTime } from '../media-bots/shared';
import type { ConsoleSourceContext } from './SourcePicker';

type MusicView = 'songs' | 'playlists' | 'recent';

const VIEWS: { id: MusicView; label: string }[] = [
  { id: 'songs', label: 'Songs' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'recent', label: 'Recent requests' },
];

function useListPaging(listKey: string, search: string) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(() => rememberedPageSize(listKey));
  useEffect(() => { setPage(1); }, [search]);
  return { page, setPage, pageSize, setPageSize };
}

export function MusicSource(ctx: ConsoleSourceContext) {
  const [view, setView] = useState<MusicView>('songs');
  const [search, setSearch] = useState('');

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Music views" className="flex flex-wrap gap-1">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            className={cn(
              'min-h-11 rounded-md px-3 text-sm',
              view === v.id ? 'bg-primary font-semibold text-primary-foreground' : 'bg-muted/40 text-muted-foreground hover:text-foreground',
            )}
            onClick={() => { setView(v.id); setSearch(''); }}
          >
            {v.label}
          </button>
        ))}
      </div>
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={view === 'songs' ? 'Search songs…' : view === 'playlists' ? 'Search playlists…' : 'Search recent requests…'}
        aria-label={view === 'songs' ? 'Search songs' : view === 'playlists' ? 'Search playlists' : 'Search recent requests'}
        className="h-11"
      />
      {view === 'songs' && <SongsView ctx={ctx} search={search} />}
      {view === 'playlists' && <PlaylistsView ctx={ctx} search={search} />}
      {view === 'recent' && <RecentView ctx={ctx} search={search} />}
    </div>
  );
}

function SongsView({ ctx, search }: { ctx: ConsoleSourceContext; search: string }) {
  const { page, setPage, pageSize, setPageSize } = useListPaging('console-songs', search);
  const [debouncedSearch, setDebouncedSearch] = useState(search.trim());
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const query = useSongSearch(ctx.serverConfigId, debouncedSearch, page, pageSize);
  const play = usePlaySong();
  const enqueue = useEnqueue();
  const songs = (query.data?.songs ?? []) as SongInfo[];
  const total = query.data?.total ?? 0;
  const pending = play.isPending || enqueue.isPending;
  const error = play.error ?? enqueue.error ?? query.error;

  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(error, 'Could not load songs')}</p>}
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading songs…</p>
      ) : songs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No songs found.</p>
      ) : (
        <ul className="space-y-1">
          {songs.map((song) => (
            <li key={song.id} className="flex items-center gap-2 rounded-md px-1 py-1">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{song.title}</p>
                {song.artist && <p className="truncate text-xs text-muted-foreground">{song.artist}</p>}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">{formatTime(song.duration)}</span>
              <Button
                variant="default"
                size="icon"
                className="h-11 w-11 shrink-0"
                disabled={pending}
                aria-label={`Play ${song.title}`}
                onClick={() => play.mutate({ botId: ctx.botId, songId: song.id })}
              >
                <Play className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-11 w-11 shrink-0"
                disabled={pending}
                aria-label={`Queue ${song.title}`}
                onClick={() => enqueue.mutate({ botId: ctx.botId, songId: song.id })}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Pager
        listKey="console-songs"
        total={total}
        page={page}
        pageSize={pageSize}
        noun="songs"
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}

function PlaylistsView({ ctx, search }: { ctx: ConsoleSourceContext; search: string }) {
  const { page, setPage, pageSize, setPageSize } = useListPaging('console-playlists', search);
  const query = usePlaylists(ctx.serverConfigId);
  const load = useLoadPlaylist();
  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    const list = (Array.isArray(query.data) ? query.data : []) as PlaylistSummary[];
    if (!q) return list;
    return list.filter((pl) => pl.name.toLowerCase().includes(q));
  }, [query.data, q]);
  const pageItems = pageSlice(filtered, page, pageSize);
  const pending = load.isPending;
  const error = load.error ?? query.error;

  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(error, 'Could not load playlists')}</p>}
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading playlists…</p>
      ) : pageItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">No playlists found.</p>
      ) : (
        <ul className="space-y-1">
          {pageItems.map((pl) => (
            <li key={pl.id} className="flex items-center gap-2 rounded-md px-1 py-1">
              <ListMusic className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{pl.name}</p>
                <p className="text-xs text-muted-foreground">
                  {pl.songCount} song{pl.songCount !== 1 ? 's' : ''}
                </p>
              </div>
              <Button
                variant="default"
                size="icon"
                className="h-11 w-11 shrink-0"
                disabled={pending}
                aria-label={`Play ${pl.name}`}
                onClick={() => load.mutate({ botId: ctx.botId, playlistId: pl.id, clearFirst: true })}
              >
                <Play className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-11 w-11 shrink-0"
                disabled={pending}
                aria-label={`Queue ${pl.name}`}
                onClick={() => load.mutate({ botId: ctx.botId, playlistId: pl.id, clearFirst: false })}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Pager
        listKey="console-playlists"
        total={filtered.length}
        page={page}
        pageSize={pageSize}
        noun="playlists"
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}

function RecentView({ ctx, search }: { ctx: ConsoleSourceContext; search: string }) {
  const { page, setPage, pageSize, setPageSize } = useListPaging('console-recent', search);
  const query = useQuery({
    queryKey: ['music-requests', ctx.serverConfigId],
    queryFn: () => musicRequestsApi.list(ctx.serverConfigId),
  });
  const playUrl = usePlayUrl();
  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    const list = Array.isArray(query.data) ? query.data : [];
    if (!q) return list;
    return list.filter((req) => req.title.toLowerCase().includes(q));
  }, [query.data, q]);
  const pageItems = pageSlice(filtered, page, pageSize);
  const pending = playUrl.isPending;
  const error = playUrl.error ?? query.error;

  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(error, 'Could not load recent requests')}</p>}
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading recent requests…</p>
      ) : pageItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recent requests.</p>
      ) : (
        <ul className="space-y-1">
          {pageItems.map((req) => (
            <li key={req.id} className="flex items-center gap-2 rounded-md px-1 py-1">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={req.title}>{req.title}</p>
              </div>
              <Button
                variant="default"
                size="icon"
                className="h-11 w-11 shrink-0"
                disabled={pending}
                aria-label={`Play ${req.title}`}
                onClick={() => playUrl.mutate({ botId: ctx.botId, url: req.url })}
              >
                <Play className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-11 w-11 shrink-0"
                disabled={pending}
                aria-label={`Queue ${req.title}`}
                onClick={() => playUrl.mutate({ botId: ctx.botId, url: req.url, enqueue: true })}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Pager
        listKey="console-recent"
        total={filtered.length}
        page={page}
        pageSize={pageSize}
        noun="requests"
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}
