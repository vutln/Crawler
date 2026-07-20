import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isMarketplace } from '@/domain';
import type { Marketplace, ProductListQuery, ProductSortBy, SortOrder } from '@/types';

export interface ProductFilters {
  page: number;
  pageSize: number;
  search: string;
  marketplace?: Marketplace;
  /**
   * Only products this keyword surfaced. No guard function (unlike isMarketplace):
   * it's a server-side id, so an unknown value matches nothing and the list is
   * simply empty — which degrades better than a 400 on a hand-edited URL.
   */
  keywordId?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  sortBy: ProductSortBy;
  sortOrder: SortOrder;
}

const SORT_FIELDS: ProductSortBy[] = ['title', 'price', 'lastScrapedAt', 'firstSeenAt', 'rating'];

function intParam(value: string | null, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function floatParam(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The URL is the filter store — no useState for filters anywhere.
 * Garbage params degrade to defaults; a hand-edited URL must not white-screen.
 */
export function useProductsQueryParams() {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo<ProductFilters>(() => {
    const marketplace = searchParams.get('marketplace');
    const sortBy = searchParams.get('sortBy') as ProductSortBy | null;
    const inStock = searchParams.get('inStock');

    return {
      page: intParam(searchParams.get('page'), 1),
      pageSize: intParam(searchParams.get('pageSize'), 25),
      search: searchParams.get('search') ?? '',
      marketplace: isMarketplace(marketplace) ? marketplace : undefined,
      keywordId: searchParams.get('keywordId') ?? undefined,
      minPrice: floatParam(searchParams.get('minPrice')),
      maxPrice: floatParam(searchParams.get('maxPrice')),
      inStock: inStock === 'true' ? true : inStock === 'false' ? false : undefined,
      sortBy: sortBy && SORT_FIELDS.includes(sortBy) ? sortBy : 'lastScrapedAt',
      sortOrder: searchParams.get('sortOrder') === 'asc' ? 'asc' : 'desc',
    };
  }, [searchParams]);

  const setFilters = useCallback(
    (patch: Partial<ProductFilters>, opts?: { replace?: boolean }) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);

          // Any non-paging change resets to page 1, else you filter down to 12
          // results while stranded on page 7 looking at an empty table.
          const changesFilters = Object.keys(patch).some((k) => k !== 'page');
          const merged: Partial<ProductFilters> =
            changesFilters && patch.page === undefined ? { ...patch, page: 1 } : patch;

          for (const [key, value] of Object.entries(merged)) {
            if (value === undefined || value === null || value === '') next.delete(key);
            else next.set(key, String(value));
          }

          // Defaults are implicit; keep shared URLs short.
          if (next.get('page') === '1') next.delete('page');
          if (next.get('pageSize') === '25') next.delete('pageSize');

          return next;
        },
        { replace: opts?.replace ?? false },
      );
    },
    [setSearchParams],
  );

  const reset = useCallback(() => setSearchParams(new URLSearchParams()), [setSearchParams]);

  /** Shape the API actually wants. */
  const query = useMemo<ProductListQuery>(
    () => ({
      page: filters.page,
      pageSize: filters.pageSize,
      ...(filters.search && { search: filters.search }),
      ...(filters.marketplace && { marketplace: filters.marketplace }),
      ...(filters.keywordId && { keywordId: filters.keywordId }),
      ...(filters.minPrice !== undefined && { minPrice: filters.minPrice }),
      ...(filters.maxPrice !== undefined && { maxPrice: filters.maxPrice }),
      ...(filters.inStock !== undefined && { inStock: filters.inStock }),
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
    }),
    [filters],
  );

  const hasActiveFilters =
    Boolean(filters.search) ||
    filters.marketplace !== undefined ||
    // Load-bearing: arriving from a keyword deep-link with no matches would
    // otherwise show "No products collected yet — go run a crawl" and no way to
    // clear, rather than "nothing matches this filter".
    filters.keywordId !== undefined ||
    filters.minPrice !== undefined ||
    filters.maxPrice !== undefined ||
    filters.inStock !== undefined;

  return { filters, setFilters, reset, query, hasActiveFilters };
}
