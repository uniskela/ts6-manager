import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Search,
  X,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type DataTableDensity = 'comfortable' | 'compact';

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  /** Enables the existing global search across every searchable column. */
  searchEnabled?: boolean;
  /** @deprecated Use searchEnabled. This value never selected a single search column. */
  searchKey?: string;
  searchPlaceholder?: string;
  searchLabel?: string;
  pageSize?: number;
  density?: DataTableDensity;
  stickyHeader?: boolean;
  tableLabel?: string;
  emptyText?: string;
  filteredEmptyText?: string;
}

const densityClasses: Record<DataTableDensity, { header: string; cell: string }> = {
  comfortable: {
    header: 'px-3 py-2.5',
    cell: 'px-3 py-2.5',
  },
  compact: {
    header: 'px-3 py-1.5',
    cell: 'px-3 py-1.5',
  },
};

function headerLabel(header: unknown, columnId: string) {
  if (typeof header === 'string') return header;
  return columnId.replace(/_/g, ' ').replace(/^./, (character: string) => character.toUpperCase());
}

export function DataTable<TData, TValue>({
  columns,
  data,
  searchEnabled = false,
  searchKey,
  searchPlaceholder = 'Search...',
  searchLabel = 'Search table',
  pageSize = 20,
  density = 'comfortable',
  stickyHeader = false,
  tableLabel = 'Data table',
  emptyText = 'No data available',
  filteredEmptyText = 'No results match your search',
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [scrollState, setScrollState] = useState({ overflow: false, left: false, right: false });
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableId = useId();
  const scrollHintId = `${tableId}-scroll-hint`;
  const showSearch = searchEnabled || searchKey !== undefined;

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    state: { sorting, globalFilter },
    initialState: { pagination: { pageSize } },
  });

  const updateScrollState = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
    const next = {
      overflow: maximum > 1,
      left: element.scrollLeft > 1,
      right: element.scrollLeft < maximum - 1,
    };
    setScrollState((current) => (
      current.overflow === next.overflow
        && current.left === next.left
        && current.right === next.right
        ? current
        : next
    ));
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const frame = requestAnimationFrame(updateScrollState);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateScrollState);
    observer?.observe(container);
    const renderedTable = container.querySelector('table');
    if (renderedTable) observer?.observe(renderedTable);
    window.addEventListener('resize', updateScrollState);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', updateScrollState);
    };
  }, [columns.length, data.length, updateScrollState]);

  const filteredCount = table.getFilteredRowModel().rows.length;
  const pageCount = table.getPageCount();
  const hasSearch = globalFilter.length > 0;
  const scrollHint = scrollState.right
    ? (scrollState.left ? 'Scroll horizontally for more columns' : 'Scroll right for more columns')
    : 'Scroll left for more columns';

  const setSearch = (value: string) => {
    setGlobalFilter(value);
    table.setPageIndex(0);
  };

  return (
    <div className="min-w-0 space-y-3">
      {showSearch && (
        <div className="relative w-full max-w-sm">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground sm:top-2.5" />
          <Input
            id={`${tableId}-search`}
            type="search"
            aria-label={searchLabel}
            aria-controls={tableId}
            placeholder={searchPlaceholder}
            value={globalFilter}
            onChange={(event) => setSearch(event.target.value)}
            className="h-10 pl-9 pr-11 sm:h-9"
          />
          {hasSearch && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Clear search"
              onClick={() => setSearch('')}
              className="absolute right-0 top-0"
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
      )}

      <div className="min-w-0">
        <div
          ref={scrollRef}
          id={tableId}
          className={cn(
            'w-full max-w-full rounded-md border border-border overscroll-x-contain',
            stickyHeader ? 'max-h-[min(65vh,36rem)] overflow-auto' : 'overflow-x-auto',
          )}
          tabIndex={0}
          role="region"
          aria-label={tableLabel}
          aria-describedby={scrollState.overflow ? scrollHintId : undefined}
          data-density={density}
          data-sticky-header={stickyHeader ? 'true' : 'false'}
          onScroll={updateScrollState}
        >
          <table className="min-w-full w-max text-sm">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} className="border-b border-border bg-muted">
                  {headerGroup.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    const label = headerLabel(header.column.columnDef.header, header.column.id);
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={canSort ? (sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none') : undefined}
                        className={cn(
                          'text-left align-middle font-medium text-muted-foreground',
                          densityClasses[density].header,
                          stickyHeader && 'sticky top-0 z-20 bg-muted shadow-[inset_0_-1px_0_hsl(var(--border))]',
                        )}
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            className="-my-1 flex min-h-10 w-full select-none items-center gap-1 rounded-sm text-left font-medium text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
                            onClick={header.column.getToggleSortingHandler()}
                            aria-label={`Sort by ${label}${sorted ? `, currently ${sorted === 'asc' ? 'ascending' : 'descending'}` : ', currently unsorted'}`}
                          >
                            <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                            <span aria-hidden="true" className="ml-1">
                              {sorted === 'asc' ? (
                                <ChevronUp className="h-3.5 w-3.5" />
                              ) : sorted === 'desc' ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
                              )}
                            </span>
                          </button>
                        ) : (
                          <div className="flex min-h-9 items-center">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </div>
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors motion-reduce:transition-none">
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className={cn(
                          'align-middle [&_button]:min-h-10 [&_button]:min-w-10 [&_button]:scroll-mt-12',
                          densityClasses[density].cell,
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={table.getVisibleLeafColumns().length || 1} className="h-24 px-3 text-center text-muted-foreground">
                    {data.length > 0 && hasSearch ? filteredEmptyText : emptyText}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {scrollState.overflow && (
          <p
            id={scrollHintId}
            role="status"
            className="mt-1 flex h-5 items-center justify-end gap-1 px-1 text-xs text-muted-foreground xl:hidden"
          >
            <ArrowLeftRight aria-hidden="true" className="h-3.5 w-3.5" />
            {scrollHint}
          </p>
        )}
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {filteredCount} {filteredCount === 1 ? 'result' : 'results'}
        </p>
        {filteredCount > 0 && pageCount > 1 && (
          <nav className="flex max-w-full flex-wrap items-center justify-end gap-2" aria-label="Table pagination">
            <Button
              variant="outline"
              size="sm"
              className="min-h-10"
              aria-label="Previous page"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              Previous
            </Button>
            <span className="min-w-12 text-center text-xs text-muted-foreground font-mono-data" aria-current="page" aria-live="polite">
              {table.getState().pagination.pageIndex + 1} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="min-h-10"
              aria-label="Next page"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Next
            </Button>
          </nav>
        )}
      </div>
    </div>
  );
}
