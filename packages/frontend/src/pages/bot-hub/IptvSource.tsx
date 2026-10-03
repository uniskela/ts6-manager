import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Search, Tv } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { VideoOptions } from '@/components/video/VideoOptions';
import { Pager } from '@/components/shared/Pager';
import { apiErrorMessage } from '@/lib/api-error';
import { pageSlice, rememberedPageSize, type PageSize } from '@/lib/pager';
import {
  DEFAULT_VIDEO_START_OPTIONS,
  type VideoStartOptions,
} from '@/lib/video-options';
import {
  useConsoleIptvChannels,
  useConsoleIptvGroups,
  useIptvPlaylists,
  useIptvStream,
} from '@/hooks/use-iptv';
import type { IptvConsoleChannel, IptvGroupInfo, IptvPlaylistSummary } from '@ts6/common';
import type { ConsoleSourceContext } from './SourcePicker';
import { parseIptvChannelId, parseIptvDeepLink, type IptvDeepLink } from './iptv-deep-link';

const IPTV_VIDEO_OPTIONS: VideoStartOptions = { ...DEFAULT_VIDEO_START_OPTIONS, sourceMode: 'live' };

/** Return the stable key used by IPTV deep links. */
function channelKey(channel: IptvConsoleChannel): string {
  return channel.channelKey || channel.name;
}

/** Console IPTV browser, search, and explicit stream controls. */
export function IptvSource({ serverConfigId, botId, searchParams }: ConsoleSourceContext) {
  const [deepLink] = useState<IptvDeepLink | null>(() => parseIptvDeepLink(searchParams.get('iptv')));
  // Older links carry only the key; newer ones also name the exact row.
  const [deepChannelId] = useState<number | null>(() => (deepLink ? parseIptvChannelId(searchParams.get('iptvChannel')) : null));
  const [playlistId, setPlaylistId] = useState<number | undefined>(deepLink?.playlistId);
  const [group, setGroup] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(() => rememberedPageSize('console-iptv-channels'));
  const [groupPage, setGroupPage] = useState(1);
  const [groupPageSize, setGroupPageSize] = useState<PageSize>(() => rememberedPageSize('console-iptv-groups'));
  const [options, setOptions] = useState<VideoStartOptions>(IPTV_VIDEO_OPTIONS);
  const playlistsQuery = useIptvPlaylists(serverConfigId);
  const stream = useIptvStream();
  const playlists = (Array.isArray(playlistsQuery.data) ? playlistsQuery.data : []) as IptvPlaylistSummary[];
  const deepLinkMode = !!deepLink;
  const openChannels = !!group || !!search.trim() || deepLinkMode;
  const groupsQuery = useConsoleIptvGroups(serverConfigId, playlistId);
  const channelParams = {
    serverConfigId,
    ...(playlistId ? { playlistId } : {}),
    ...(group ? { group } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(deepLinkMode ? (deepChannelId ? { channelId: deepChannelId } : { channelKey: deepLink!.channelKey }) : {}),
    page,
    pageSize: deepLinkMode ? 1 : pageSize,
  };
  const channelsQuery = useConsoleIptvChannels(channelParams);
  const groups = useMemo(() => {
    const value = groupsQuery.data;
    const rows = Array.isArray(value) ? value : value?.groups;
    return (Array.isArray(rows) ? rows : []) as IptvGroupInfo[];
  }, [groupsQuery.data]);
  const visibleGroups = useMemo(() => {
    const needle = groupFilter.trim().toLocaleLowerCase();
    return pageSlice(needle ? groups.filter((item) => item.group.toLocaleLowerCase().includes(needle)) : groups, groupPage, groupPageSize);
  }, [groupFilter, groupPage, groupPageSize, groups]);
  const channels = ((channelsQuery.data?.channels ?? []) as IptvConsoleChannel[]);
  const deepChannel = deepLinkMode
    ? channels.find((channel) => (deepChannelId ? channel.id === deepChannelId : channelKey(channel) === deepLink!.channelKey))
    : undefined;
  const deepLinkFinished = !deepLinkMode || !channelsQuery.isLoading;

  useEffect(() => {
    setPage(1);
    setGroupPage(1);
  }, [playlistId, group, search, groupFilter]);

  /** Change the playlist filter and return to the group browser. */
  const selectPlaylist = (value: string) => {
    setPlaylistId(value ? Number(value) : undefined);
    if (deepLinkMode) return;
    setGroup('');
  };

  /** Stream only after the administrator presses the channel button. */
  const startStream = (channel: IptvConsoleChannel) => {
    stream.mutate({ botId, channelId: channel.id, options });
  };

  if (deepLinkMode) {
    if (!deepLinkFinished || channelsQuery.isFetching) return <p className="text-sm text-muted-foreground">Loading channel…</p>;
    if (channelsQuery.isError) return <p role="alert" className="text-sm text-destructive">{apiErrorMessage(channelsQuery.error, 'Could not load channel')}</p>;
    if (!deepChannel) return <p className="text-sm">That channel is no longer in the playlist</p>;
    return (
      <div className="space-y-4">
        <VideoOptions value={options} onChange={setOptions} />
        {stream.error && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(stream.error, 'Failed to start stream')}</p>}
        <ChannelRow channel={deepChannel} onStream={startStream} busy={stream.isPending} />
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      <VideoOptions value={options} onChange={setOptions} />
      {stream.error && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(stream.error, 'Failed to start stream')}</p>}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-1.5">
          <Label htmlFor="console-iptv-playlist">Playlist</Label>
          <select id="console-iptv-playlist" className="h-11 w-full rounded-md border bg-background px-3 text-sm" value={playlistId ?? ''}
            onChange={(event) => selectPlaylist(event.target.value)}>
            <option value="">All playlists</option>
            {playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="console-iptv-search">Search channels</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-3 h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <Input id="console-iptv-search" className="h-11 pl-10" value={search}
              onChange={(event) => setSearch(event.target.value)} placeholder="Channel name" />
          </div>
        </div>
      </div>

      {openChannels ? (
        <section aria-labelledby="console-iptv-channel-heading" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="console-iptv-channel-heading" className="text-sm font-semibold">{group ? group : 'Search results'}</h3>
            {group && <Button type="button" variant="ghost" className="min-h-11" onClick={() => { setGroup(''); setSearch(''); setGroupFilter(''); }}><ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden="true" /> All groups</Button>}
          </div>
          {channelsQuery.isError && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(channelsQuery.error, 'Could not load channels')}</p>}
          <div className="space-y-2">
            {channels.map((channel) => <ChannelRow key={channel.id} channel={channel} onStream={startStream} busy={stream.isPending || channelsQuery.isFetching} />)}
            {!channelsQuery.isFetching && channels.length === 0 && <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No channels found.</p>}
          </div>
          <Pager listKey="console-iptv-channels" total={channelsQuery.data?.total ?? 0} page={channelsQuery.data?.page ?? page} pageSize={pageSize} noun="channels"
            onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} />
        </section>
      ) : (
        <section aria-labelledby="console-iptv-groups-heading" className="space-y-3">
          <h3 id="console-iptv-groups-heading" className="text-sm font-semibold">Browse groups</h3>
          <Input aria-label="Group filter" className="h-11" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} placeholder="Filter groups" />
          {groupsQuery.isError && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(groupsQuery.error, 'Could not load groups')}</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {visibleGroups.map((item) => (
              <button key={item.group} type="button" className="flex min-h-11 items-center justify-between rounded-md border px-3 text-left hover:bg-muted/50" onClick={() => { setGroup(item.group); setSearch(''); setGroupFilter(''); }}>
                <span className="flex min-w-0 items-center gap-2"><Tv className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="truncate">{item.group}</span></span>
                <span className="text-xs text-muted-foreground">{item.count}</span>
              </button>
            ))}
          </div>
          {!groupsQuery.isFetching && groups.length === 0 && <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No groups found.</p>}
          <Pager listKey="console-iptv-groups" total={groupFilter ? groups.filter((item) => item.group.toLocaleLowerCase().includes(groupFilter.trim().toLocaleLowerCase())).length : groups.length} page={groupPage} pageSize={groupPageSize} noun="groups"
            onPageChange={setGroupPage} onPageSizeChange={(size) => { setGroupPageSize(size); setGroupPage(1); }} />
        </section>
      )}
    </div>
  );
}

/** Render one channel row without allowing stale placeholder results to stream. */
function ChannelRow({ channel, onStream, busy }: { channel: IptvConsoleChannel; onStream(channel: IptvConsoleChannel): void; busy: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border p-2.5">
      {channel.logo ? <img src={channel.logo} alt="" className="h-10 w-10 shrink-0 rounded object-contain" /> : <Tv className="h-10 w-10 shrink-0 rounded bg-muted p-2 text-muted-foreground" aria-hidden="true" />}
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{channel.name}</p><p className="truncate text-xs text-muted-foreground">{channel.playlistName}{channel.group ? ` · ${channel.group}` : ''}</p></div>
      <Button type="button" className="min-h-11 shrink-0" aria-label={`Stream ${channel.name}`} disabled={busy} onClick={() => onStream(channel)}>Stream</Button>
    </div>
  );
}
