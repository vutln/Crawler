import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getPriceHistory, getProduct, listProducts } from '@/api/endpoints';
import { queryKeys } from '@/api/queryKeys';
import type { PriceHistoryInterval, ProductListQuery } from '@/types/api';

export function useProducts(query: ProductListQuery) {
  return useQuery({
    queryKey: queryKeys.products.list(query),
    queryFn: ({ signal }) => listProducts(query, signal),
    // Keeps the previous page's rows on screen while the next page loads, so the
    // table never collapses to a spinner and reflows the whole layout.
    placeholderData: keepPreviousData,
  });
}

export function useProduct(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.products.detail(id ?? ''),
    queryFn: ({ signal }) => getProduct(id!, signal),
    enabled: Boolean(id),
  });
}

export type HistoryRange = '7d' | '30d' | '90d' | 'all';

const RANGE_DAYS: Record<HistoryRange, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
};

export function usePriceHistory(id: string | undefined, range: HistoryRange) {
  return useQuery({
    queryKey: queryKeys.products.priceHistory(id ?? '', range),
    queryFn: ({ signal }) => {
      const days = RANGE_DAYS[range];
      const from = days ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;

      // Bucket server-side on long ranges. A product scraped hourly for a year
      // is ~8,760 points — too fat to ship and more than a chart can draw
      // meaningfully across 800px.
      const interval: PriceHistoryInterval =
        range === '7d' ? 'raw' : range === '30d' ? 'hour' : 'day';

      return getPriceHistory(id!, { from, interval }, signal);
    },
    enabled: Boolean(id),
  });
}
