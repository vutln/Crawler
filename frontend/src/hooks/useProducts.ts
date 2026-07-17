import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { exportProductsCsv, getPriceHistory, getProduct, listProducts } from '@/api/endpoints';
import { ApiError } from '@/api/http';
import { queryKeys } from '@/api/queryKeys';
import { downloadBlob } from '@/lib/download';
import type { PriceHistoryInterval, ProductExportQuery, ProductListQuery } from '@/types/api';

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

/**
 * Download the current filter as CSV.
 *
 * A mutation, not a query: it is user-triggered, must never be cached or refetched
 * (a background refetch would re-download a file), and `isPending` gives the button
 * its disabled state for free. It has no cache entry, so queryKeys needs no entry
 * either — same shape as useCancelRun.
 */
export function useExportProductsCsv() {
  return useMutation({
    mutationFn: (query: ProductExportQuery) => exportProductsCsv(query),
    onSuccess: ({ blob, filename }) => {
      // Fallback matters in production: the browser hides Content-Disposition from
      // JS cross-origin without Access-Control-Expose-Headers, and dev is
      // same-origin via the Vite proxy, so its absence would only bite after deploy.
      downloadBlob(blob, filename ?? `products-${new Date().toISOString().slice(0, 10)}.csv`);
    },
    onError: (error) => {
      // The CSV endpoint still errors as JSON (Nest's exception filter), so this is
      // a real message rather than a downloaded error page.
      toast.error(error instanceof ApiError ? error.message : 'Export failed');
    },
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
