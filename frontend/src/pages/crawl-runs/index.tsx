import { useCrawlRuns } from '@/hooks/useCrawls';
import { useCrawlRunsQueryParams } from '@/hooks/useCrawlRunsQueryParams';
import { RunsFilterBar } from './components/RunsFilterBar';
import { RunsTable } from './components/RunsTable';

/**
 * Collection history.
 *
 * Its own route rather than a panel under /crawl-jobs: a sweep of N keywords emits
 * N runs per site per day, which is the bulk of what this system produces and
 * deserves the room. Filters live in the URL so "here's the failing eBay run" is a
 * link.
 */
export default function CrawlRunsPage() {
  const { filters, setFilters, reset, query, hasActiveFilters } = useCrawlRunsQueryParams();
  // Same query key as RunsTable's, so this shares the cache entry rather than
  // firing a second request just to read the count.
  const runs = useCrawlRuns(query);

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-slate-900">History</h1>
        <span className="tnum text-xs text-slate-500">
          {runs.data ? `${runs.data.total.toLocaleString()} runs` : '—'}
        </span>
      </header>

      <RunsFilterBar
        filters={filters}
        onChange={setFilters}
        onReset={reset}
        hasActiveFilters={hasActiveFilters}
        isRefreshing={runs.isFetching && !runs.isPending}
      />

      <RunsTable />
    </div>
  );
}
