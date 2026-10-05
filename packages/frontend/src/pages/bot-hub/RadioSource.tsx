/**
 * Console Radio tab: search, mood chips from station genre tags, Play.
 */

import { useEffect, useMemo, useState } from 'react';
import { Play, Radio } from 'lucide-react';
import type { RadioStationInfo } from '@ts6/common';
import { Pager } from '@/components/shared/Pager';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePlayRadio, useRadioStations } from '@/hooks/use-radio-stations';
import { apiErrorMessage } from '@/lib/api-error';
import { pageSlice, rememberedPageSize, type PageSize } from '@/lib/pager';
import { RADIO_MOOD_CHIP_LIMIT, radioMoods, splitGenreTags, stationHasMood } from '@/lib/radio-moods';
import { cn } from '@/lib/utils';
import { AddMediaLink } from './AddMediaLink';
import type { ConsoleSourceContext } from './SourcePicker';

export function RadioSource(ctx: ConsoleSourceContext) {
  const [search, setSearch] = useState('');
  const [mood, setMood] = useState<string | null>(null); // mood key; null = All
  const [showAllMoods, setShowAllMoods] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(() => rememberedPageSize('console-radio'));
  const stationsQuery = useRadioStations(ctx.serverConfigId);
  const playRadio = usePlayRadio();

  useEffect(() => { setPage(1); }, [search, mood]);

  const stations = (Array.isArray(stationsQuery.data) ? stationsQuery.data : []) as RadioStationInfo[];

  const moods = useMemo(() => radioMoods(stations), [stations]);
  const visibleMoods = useMemo(() => {
    if (showAllMoods || moods.length <= RADIO_MOOD_CHIP_LIMIT) return moods;
    const top = moods.slice(0, RADIO_MOOD_CHIP_LIMIT);
    const selected = mood != null && !top.some((m) => m.key === mood) ? moods.find((m) => m.key === mood) : undefined;
    return selected ? [...top, selected] : top;
  }, [moods, showAllMoods, mood]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stations.filter((s) => {
      if (mood != null && !stationHasMood(s.genre, mood)) return false;
      if (!q) return true;
      const hay = `${s.name} ${s.genre ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [stations, search, mood]);

  const pageItems = pageSlice(filtered, page, pageSize);
  const pending = playRadio.isPending;
  const error = playRadio.error ?? stationsQuery.error;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search stations…"
          aria-label="Search stations"
          className="h-11 min-w-0 flex-1 basis-48"
        />
        <AddMediaLink to="/media-bots?tab=radio" label="Add station" />
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Moods">
        <button
          type="button"
          className={cn(
            'min-h-11 rounded-md px-3 text-sm',
            mood === null ? 'bg-primary font-semibold text-primary-foreground' : 'bg-muted/40 text-muted-foreground hover:text-foreground',
          )}
          aria-pressed={mood === null}
          onClick={() => setMood(null)}
        >
          All ({stations.length})
        </button>
        {visibleMoods.map(({ key, label, count }) => (
          <button
            key={key}
            type="button"
            className={cn(
              'min-h-11 rounded-md px-3 text-sm',
              mood === key ? 'bg-primary font-semibold text-primary-foreground' : 'bg-muted/40 text-muted-foreground hover:text-foreground',
            )}
            aria-pressed={mood === key}
            onClick={() => setMood(key)}
          >
            {label} ({count})
          </button>
        ))}
        {moods.length > RADIO_MOOD_CHIP_LIMIT && (
          <button
            type="button"
            className="min-h-11 rounded-md px-3 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            aria-expanded={showAllMoods}
            onClick={() => setShowAllMoods((v) => !v)}
          >
            {showAllMoods ? 'Fewer moods' : `More moods (${moods.length - RADIO_MOOD_CHIP_LIMIT})`}
          </button>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{apiErrorMessage(error, 'Could not load stations')}</p>}
      {stationsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading stations…</p>
      ) : pageItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">No stations found.</p>
      ) : (
        <ul className="space-y-1">
          {pageItems.map((station) => (
            <li key={station.id} className="flex items-center gap-2 rounded-md px-1 py-1">
              <Radio className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{station.name}</p>
                {station.genre && <p className="truncate text-xs text-muted-foreground">{splitGenreTags(station.genre).join(' · ')}</p>}
              </div>
              <Button
                variant="default"
                size="icon"
                className="h-11 w-11 shrink-0"
                disabled={pending}
                aria-label={`Play ${station.name}`}
                onClick={() => playRadio.mutate({ botId: ctx.botId, stationId: station.id })}
              >
                <Play className="h-4 w-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Pager
        listKey="console-radio"
        total={filtered.length}
        page={page}
        pageSize={pageSize}
        noun="stations"
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
      <p className="text-xs text-muted-foreground">
        Moods come from each station&apos;s genre. Set or change it under Media Library → Radio stations.
      </p>
    </div>
  );
}
