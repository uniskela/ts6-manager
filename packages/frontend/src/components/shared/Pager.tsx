import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PAGE_SIZES, pageCount, pageRangeLabel, rememberPageSize, type PageSize } from '@/lib/pager';

interface PagerProps {
  /** Remembers the chosen page size for this list (for example "console-songs"). */
  listKey: string;
  total: number;
  page: number;
  pageSize: PageSize;
  noun: string;
  onPageChange(page: number): void;
  onPageSizeChange(size: PageSize): void;
}

/**
 * "1–50 of 148 channels", page buttons and a Per page picker (25 / 50 / 100).
 * Collapses to "‹ Page 2 of 3 ›" on narrow screens.
 */
export function Pager({ listKey, total, page, pageSize, noun, onPageChange, onPageSizeChange }: PagerProps) {
  const pages = pageCount(total, pageSize);
  const first = Math.max(1, Math.min(page - 1, pages - 2));
  const numbers = Array.from({ length: Math.min(3, pages) }, (_, i) => first + i);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{pageRangeLabel(total, page, pageSize, noun)}</span>
      <nav aria-label="Pages" className="flex items-center gap-1">
        <Button variant="outline" size="icon" className="h-9 w-9" aria-label="Previous page"
          disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="px-2 sm:hidden">Page {page} of {pages}</span>
        {numbers.map((n) => (
          <Button key={n} variant={n === page ? 'default' : 'outline'} size="sm"
            className="hidden h-9 min-w-9 sm:inline-flex" aria-current={n === page ? 'page' : undefined}
            onClick={() => onPageChange(n)}>
            {n}
          </Button>
        ))}
        <Button variant="outline" size="icon" className="h-9 w-9" aria-label="Next page"
          disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </nav>
      <label className="flex items-center gap-1.5">
        Per page
        <select
          className="h-9 rounded-md border bg-background px-2 text-foreground"
          value={pageSize}
          onChange={(e) => {
            const size = Number(e.target.value) as PageSize;
            rememberPageSize(listKey, size);
            onPageSizeChange(size);
          }}
        >
          {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
    </div>
  );
}
