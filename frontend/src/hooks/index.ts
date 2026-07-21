/**
 * Barrel for the data hooks. Import from '@/hooks'.
 *
 * Every hook here wraps TanStack Query and owns its own cache invalidation, so a
 * component never touches queryClient directly. The URL-as-filter-store hooks
 * (useProductsQueryParams, useCrawlRunsQueryParams) are the exception in kind —
 * they hold no cache, they make the URL the single source of truth for filters.
 */

// Products
export type { HistoryRange } from './useProducts';
export {
  useProducts,
  useProduct,
  useExportProductsCsv,
  usePriceHistory,
} from './useProducts';

// Keywords
export {
  useKeywords,
  useCreateKeyword,
  useBulkCreateKeywords,
  useUpdateKeyword,
  useDeleteKeyword,
} from './useKeywords';

// Crawl jobs and runs
export {
  useCrawlJobs,
  useCrawlJob,
  useCrawlRuns,
  useTriggerCrawl,
  useCancelRun,
  useCreateCrawlJob,
  useUpdateCrawlJob,
  useDeleteCrawlJob,
} from './useCrawls';

// Filter state, stored in the URL rather than component state
export type { ProductFilters } from './useProductsQueryParams';
export { useProductsQueryParams } from './useProductsQueryParams';
export type { RunFilters } from './useCrawlRunsQueryParams';
export { useCrawlRunsQueryParams } from './useCrawlRunsQueryParams';

// Generic
export { useDebouncedValue } from './useDebouncedValue';
