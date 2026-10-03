import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Search, Star, Tv } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { VideoOptions } from '@/components/video/VideoOptions';
import { useVideoStartOptions } from '@/hooks/use-video-streaming';
import { Pager } from '@/components/shared/Pager';
import { apiErrorMessage } from '@/lib/api-error';
import { clampPage, pageSlice, rememberedPageSize, type PageSize } from '@/lib/pager';
import {
  useConsoleIptvChannels,
  useConsoleIptvGroups,
  useIptvPlaylists,
  useIptvFilters,
  useIptvFavourites,
  useIptvRecent,
  useSetIptvFavourite,
  useIptvStream,
} from '@/hooks/use-iptv';
import type { IptvChannelPickInfo, IptvConsoleChannel, IptvGroupInfo, IptvPlaylistSummary } from '@ts6/common';
import { AddMediaLink } from './AddMediaLink';
import type { ConsoleSourceContext } from './SourcePicker';
import { parseIptvChannelId, parseIptvDeepLink, type IptvDeepLink } from './iptv-deep-link';

type IptvView = 'Favourites' | 'Recent' | 'Browse groups';

/** Return the stable key used by IPTV deep links. */
function channelKey(channel: IptvConsoleChannel): string {
  return channel.channelKey || channel.name;
}

/** Metadata uses exact codes, including playlists with several countries or languages. */
function matchesMetadata(value: string | null | undefined, selected: string): boolean {
  return !selected || (value ?? '').split(/[;,]/).some((code) => code.trim().toLowerCase() === selected.toLowerCase());
}

/** Console IPTV browser, search, and explicit stream controls. */
export function IptvSource({ serverConfigId, botId, searchParams }: ConsoleSourceContext) {
  const [deepLink] = useState<IptvDeepLink | null>(() => parseIptvDeepLink(searchParams.get('iptv')));
  // Older links carry only the key; newer ones also name the exact row.
  const [deepChannelId] = useState<number | null>(() => (deepLink ? parseIptvChannelId(searchParams.get('iptvChannel')) : null));
  const [playlistId, setPlaylistId] = useState<number | undefined>(deepLink?.playlistId);
  const [group, setGroup] = useState('');
  const [country, setCountry] = useState('');
  const [language, setLanguage] = useState('');
  const [view, setView] = useState<IptvView | null>(null);
  const [groupFilter, setGroupFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(() => rememberedPageSize('console-iptv-channels'));
  const [groupPage, setGroupPage] = useState(1);
  const [groupPageSize, setGroupPageSize] = useState<PageSize>(() => rememberedPageSize('console-iptv-groups'));
  const [options, setOptions, optionsLoading, defaults] = useVideoStartOptions(serverConfigId, 'live');
  const playlistsQuery = useIptvPlaylists(serverConfigId);
  const filtersQuery = useIptvFilters(serverConfigId);
  const countries = filtersQuery.data?.countries ?? [];
  const languages = filtersQuery.data?.languages ?? [];
  const metadataFilters = { ...(country ? { country } : {}), ...(language ? { language } : {}) };
  const favouritesQuery = useIptvFavourites(serverConfigId);
  const recentQuery = useIptvRecent(serverConfigId);
  const setFavourite = useSetIptvFavourite();
  const favourites = favouritesQuery.data ?? [];
  const currentView = view ?? 'Browse groups';
  const picksQuery = currentView === 'Recent' ? recentQuery : favouritesQuery;
  const picks = (picksQuery.data ?? []).filter((pick) =>
    (!playlistId || pick.playlistId === playlistId)
    && matchesMetadata(pick.channel?.tvgCountry, country)
    && matchesMetadata(pick.channel?.tvgLanguage, language)
    && (pick.channel?.name ?? pick.name).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  // Removing the last pick on a page would otherwise leave an empty page behind.
  const picksPage = clampPage(page, picks.length, pageSize);
  const stream = useIptvStream();
  const playlists = (Array.isArray(playlistsQuery.data) ? playlistsQuery.data : []) as IptvPlaylistSummary[];
  const deepLinkMode = !!deepLink;
  const openChannels = !!group || !!search.trim() || deepLinkMode;
  const groupsQuery = useConsoleIptvGroups(serverConfigId, playlistId, metadataFilters);
  const channelParams = {
    serverConfigId,
    ...metadataFilters,
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
  }, [playlistId, group, search, groupFilter, view, country, language]);

  useEffect(() => {
    const values = filtersQuery.data;
    if (!values) return;
    // A refreshed playlist can remove the last value behind a selected filter.
    if (country && !values.countries.includes(country)) setCountry('');
    if (language && !values.languages.includes(language)) setLanguage('');
  }, [filtersQuery.data, country, language]);

  useEffect(() => {
    if (favouritesQuery.isSuccess || favouritesQuery.isError) {
      // An explicit selection made while the request loads always wins.
      setView((selected) => selected ?? (favourites.length ? 'Favourites' : 'Browse groups'));
    }
  }, [favouritesQuery.isSuccess, favouritesQuery.isError, favourites.length]);

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

  const isFavourite = (channel: IptvConsoleChannel) => favourites.some((pick) =>
    pick.playlistId === channel.playlistId && pick.channelKey === channelKey(channel),
  );
  const toggleFavourite = (channel: IptvConsoleChannel) => {
    setFavourite.mutate({ serverConfigId, playlistId: channel.playlistId, channelKey: channelKey(channel), favourite: !isFavourite(channel) });
  };
  const removeMissingPick = (pick: IptvChannelPickInfo) => {
    setFavourite.mutate({ serverConfigId, playlistId: pick.playlistId, channelKey: pick.channelKey, favourite: false, removeRecent: true });
  };
  const renderChannel = (channel: IptvConsoleChannel, fetching: boolean) => (
    <ChannelRow key={`${channel.playlistId}:${channelKey(channel)}`} channel={channel} onStream={startStream}
      busy={stream.isPending || optionsLoading || fetching} favourite={isFavourite(channel)} onToggleFavourite={toggleFavourite}
      favouriteBusy={setFavourite.isPending || favouritesQuery.isFetching || favouritesQuery.isError} />
  );
  const favouriteError = setFavourite.error ?? favouritesQuery.error;

  if (deepLinkMode) {
    if (!deepLinkFinished || channelsQuery.isFetching) return <p className="text-sm text-muted-foreground">Loading channel…</p>;
    if (channelsQuery.isError) return <p role="alert" className="text-sm text-destructive">{apiErrorMessage(channelsQuery.error, 'Could not load channel')}</p>;
    if (!deepChannel) return <p className="text-sm">That channel is no longer in the playlist</p>;
    return (
      <div className="space-y-4">
        <VideoOptions value={options} onChange={setOptions} defaults={defaults} />
        {stream.error && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(stream.error, 'Failed to start stream')}</p>}
        {favouriteError && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(favouriteError, 'Could not load favourites')}</p>}
        {renderChannel(deepChannel, channelsQuery.isFetching)}
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      <VideoOptions value={options} onChange={setOptions} defaults={defaults} />
      {stream.error && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(stream.error, 'Failed to start stream')}</p>}
      {favouriteError && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(favouriteError, 'Could not load favourites')}</p>}
      {filtersQuery.error && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(filtersQuery.error, 'Could not load filters')}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="IPTV views" className="flex flex-wrap gap-1.5">
          {(['Favourites', 'Recent', 'Browse groups'] as const).map((name) => (
            <Button key={name} type="button" variant={currentView === name ? 'default' : 'outline'} className="min-h-11"
              aria-pressed={currentView === name} onClick={() => { setView(name); setPage(1); }}>{name}</Button>
          ))}
        </div>
        <AddMediaLink to="/iptv" label="Add playlist" />
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-1.5">
          <Label htmlFor="console-iptv-playlist">Playlist</Label>
          <select id="console-iptv-playlist" className="h-11 w-full rounded-md border bg-background px-3 text-sm" value={playlistId ?? ''}
            onChange={(event) => selectPlaylist(event.target.value)}>
            <option value="">All playlists</option>
            {playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}
          </select>
        </div>
        {countries.length > 0 && (
          <div className="space-y-1.5">
            <Label htmlFor="console-iptv-country">Country</Label>
            <select id="console-iptv-country" className="h-11 w-full rounded-md border bg-background px-3 text-sm" value={country}
              onChange={(event) => setCountry(event.target.value)}>
              <option value="">All countries</option>
              {countries.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
        )}
        {languages.length > 0 && (
          <div className="space-y-1.5">
            <Label htmlFor="console-iptv-language">Language</Label>
            <select id="console-iptv-language" className="h-11 w-full rounded-md border bg-background px-3 text-sm" value={language}
              onChange={(event) => setLanguage(event.target.value)}>
              <option value="">All languages</option>
              {languages.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="console-iptv-search">Search channels</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-3 h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <Input id="console-iptv-search" className="h-11 pl-10" value={search}
              onChange={(event) => setSearch(event.target.value)} placeholder="Channel name" />
          </div>
        </div>
      </div>

      {currentView !== 'Browse groups' ? (
        <section aria-labelledby="console-iptv-picks-heading" className="space-y-3">
          <h3 id="console-iptv-picks-heading" className="text-sm font-semibold">{currentView}</h3>
          {currentView === 'Recent' && recentQuery.isError && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(recentQuery.error, 'Could not load recent channels')}</p>}
          {picksQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading channels…</p> : (
            <div className="space-y-2">
              {pageSlice(picks, picksPage, pageSize).map((pick) => pick.channel ? renderChannel(pick.channel, picksQuery.isFetching) : (
                <div key={`${pick.playlistId}:${pick.channelKey}`} className="flex min-w-0 items-center gap-3 rounded-md border p-2.5">
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{pick.name}</p><p className="text-xs text-muted-foreground">No longer in this playlist</p></div>
                  <Button type="button" variant="outline" className="min-h-11 shrink-0" aria-label={`Remove ${pick.name}`}
                    disabled={setFavourite.isPending || picksQuery.isFetching} onClick={() => removeMissingPick(pick)}>Remove</Button>
                </div>
              ))}
              {!picksQuery.isError && picks.length === 0 && <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No channels found.</p>}
            </div>
          )}
          <Pager listKey="console-iptv-channels" total={picks.length} page={picksPage} pageSize={pageSize} noun="channels"
            onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} />
        </section>
      ) : openChannels ? (
        <section aria-labelledby="console-iptv-channel-heading" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="console-iptv-channel-heading" className="text-sm font-semibold">{group ? group : 'Search results'}</h3>
            {group && <Button type="button" variant="ghost" className="min-h-11" onClick={() => { setGroup(''); setSearch(''); setGroupFilter(''); }}><ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden="true" /> All groups</Button>}
          </div>
          {channelsQuery.isError && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(channelsQuery.error, 'Could not load channels')}</p>}
          <div className="space-y-2">
            {channels.map((channel) => renderChannel(channel, channelsQuery.isFetching))}
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
function ChannelRow({ channel, onStream, busy, favourite, onToggleFavourite, favouriteBusy }: {
  channel: IptvConsoleChannel; onStream(channel: IptvConsoleChannel): void; busy: boolean;
  favourite: boolean; onToggleFavourite(channel: IptvConsoleChannel): void; favouriteBusy: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border p-2.5">
      {channel.logo ? <img src={channel.logo} alt="" className="h-10 w-10 shrink-0 rounded object-contain" /> : <Tv className="h-10 w-10 shrink-0 rounded bg-muted p-2 text-muted-foreground" aria-hidden="true" />}
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{channel.name}</p><p className="truncate text-xs text-muted-foreground">{channel.playlistName}{channel.group ? ` · ${channel.group}` : ''}</p></div>
      <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-pressed={favourite}
        aria-label={favourite ? `Remove ${channel.name} from favourites` : `Add ${channel.name} to favourites`}
        disabled={favouriteBusy} onClick={() => onToggleFavourite(channel)}>
        <Star className={favourite ? 'h-5 w-5 fill-current text-amber-500' : 'h-5 w-5'} aria-hidden="true" />
      </Button>
      <Button type="button" className="min-h-11 shrink-0" aria-label={`Stream ${channel.name}`} disabled={busy} onClick={() => onStream(channel)}>Stream</Button>
    </div>
  );
}
