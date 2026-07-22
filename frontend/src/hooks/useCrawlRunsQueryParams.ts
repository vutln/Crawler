import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isMarketplace, isRunStatus } from '@/domain';
import type { CrawlRunListQuery, Marketplace, RunStatus } from '@/types';

export interface RunFilters {
  page: number;
  pageSize: number;
  status?: RunStatus;
  marketplace?: Marketplace;
  jobId?: string;
  keywordId?: string;
  niche?: string;
  batchId?: string;
}

const PAGE_SIZE = 25;

function intParam(value: string | null, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The URL is the filter store — modelled on useProductsQueryParams.
 *
 * A history screen is exactly the case that pattern exists for: "here's the failing
 * eBay run" should be a link you can paste to someone. It also makes the deep-links
 * from other screens (a keyword's runs, a sweep's batch) work for free.
 *
 * Garbage params degrade to defaults; a hand-edited URL must not white-screen. The
 * enum guards come from src/domain, so an unknown status is simply dropped.
 */
export function useCrawlRunsQueryParams(queryParams?: CrawlRunListQuery) {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo<RunFilters>(() => {
    const status = queryParams?.status ?? searchParams.get('status');
    const marketplace = queryParams?.marketplace ?? searchParams.get('marketplace');

    return {
      page: intParam(searchParams.get('page'), 1),
      pageSize: intParam(searchParams.get('pageSize'), PAGE_SIZE),
      status: isRunStatus(status) ? status : undefined,
      marketplace: isMarketplace(marketplace) ? marketplace : undefined,
      // Ids aren't guarded: they're server-side, so an unknown one matches nothing
      // and the list is simply empty. That degrades better than a 400.
      jobId: queryParams?.jobId ?? searchParams.get('jobId') ?? undefined,
      keywordId: queryParams?.keywordId ?? searchParams.get('keywordId') ?? undefined,
      niche: queryParams?.niche ?? searchParams.get('niche') ?? undefined,
      batchId: queryParams?.batchId ?? searchParams.get('batchId') ?? undefined,
    };
  }, [searchParams, queryParams]);

  const setFilters = useCallback(
    (patch: Partial<RunFilters>) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);

        // Any non-paging change resets to page 1, else you filter down to 3 results
        // while stranded on page 7 looking at an empty table.
        const changesFilters = Object.keys(patch).some((k) => k !== 'page');
        const merged: Partial<RunFilters> =
          changesFilters && patch.page === undefined ? { ...patch, page: 1 } : patch;

        for (const [key, value] of Object.entries(merged)) {
          if (value === undefined || value === null || value === '') next.delete(key);
          else next.set(key, String(value));
        }

        // Defaults are implicit; keep shared URLs short.
        if (next.get('page') === '1') next.delete('page');
        if (next.get('pageSize') === String(PAGE_SIZE)) next.delete('pageSize');

        return next;
      });
    },
    [setSearchParams],
  );

  const reset = useCallback(() => setSearchParams(new URLSearchParams()), [setSearchParams]);

  const query = useMemo<CrawlRunListQuery>(
    () => ({
      page: filters.page,
      pageSize: filters.pageSize,
      ...(filters.status && { status: filters.status }),
      ...(filters.marketplace && { marketplace: filters.marketplace }),
      ...(filters.jobId && { jobId: filters.jobId }),
      ...(filters.keywordId && { keywordId: filters.keywordId }),
      ...(filters.niche && { niche: filters.niche }),
      ...(filters.batchId && { batchId: filters.batchId }),
    }),
    [filters],
  );

  const hasActiveFilters = Boolean(
    filters.status ?? filters.marketplace ?? filters.jobId ?? filters.keywordId ?? filters.niche ?? filters.batchId,
  );

  return { filters, setFilters, reset, query, hasActiveFilters };
}
