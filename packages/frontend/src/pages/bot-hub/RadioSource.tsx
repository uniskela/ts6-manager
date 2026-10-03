/**
 * Console Radio tab: search, mood chips from station genre, Play.
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
import { cn } from '@/lib/utils';
import type { ConsoleSourceContext } from './SourcePicker';

export function RadioSource(ctx: ConsoleSourceContext) {
  const [search, setSearch] = useState('');
  const [mood, setMood] = useState<string | null>(null); // null = All
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(() => rememberedPageSize('console-radio'));
  const stationsQuery = useRadioStations(ctx.serverConfigId);
  const playRadio = usePlayRadio();

  useEffect(() => { setPage(1); }, [search, mood]);

  const stations = (Array.isArray(stationsQuery.data) ? stationsQuery.data : []) as RadioStationInfo[];

  const genreCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of stations) {
      const g = s.genre?.trim();
      if (!g) continue;
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [stations]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stations.filter((s) => {
      if (mood != null) {
        if ((s.genre?.trim() || '') !== mood) return false;
      }
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
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search stations…"
        aria-label="Search stations"
        className="h-11"
      />
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
        {genreCounts.map(([genre, count]) => (
          <button
            key={genre}
            type="button"
            className={cn(
              'min-h-11 rounded-md px-3 text-sm',
              mood === genre ? 'bg-primary font-semibold text-primary-foreground' : 'bg-muted/40 text-muted-foreground hover:text-foreground',
            )}
            aria-pressed={mood === genre}
            onClick={() => setMood(genre)}
          >
            {genre} ({count})
          </button>
        ))}
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
                {station.genre && <p className="truncate text-xs text-muted-foreground">{station.genre}</p>}
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
