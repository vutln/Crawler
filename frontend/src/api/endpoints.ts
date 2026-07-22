import { request, requestBlob } from './http';
import type {
  BulkCreateKeywordsResult,
  CrawlJob,
  CrawlRun,
  CrawlRunListQuery,
  CreateCrawlJobInput,
  CreateKeywordInput,
  Keyword,
  PaginatedCrawlRuns,
  PaginatedProducts,
  PricePoint,
  PriceHistoryInterval,
  Product,
  ProductExportQuery,
  ProductListQuery,
  StatsOverview,
  UpdateCrawlJobInput,
  UpdateKeywordInput,
} from '@/types';

// `signal` threaded throughout so TanStack Query can cancel in-flight requests.

export const listProducts = (query: ProductListQuery, signal?: AbortSignal) =>
  request<PaginatedProducts>('/products', { query, signal });

export const getProduct = (id: string, signal?: AbortSignal) =>
  request<Product>(`/products/${id}`, { signal });

/**
 * The CURRENT FILTER as CSV — not the current page.
 *
 * ProductExportQuery has no page/pageSize (the backend omits them), so the type
 * makes "export what I filtered" the only expressible call. Exporting the page the
 * user happens to be sitting on is the usual way this feature ships broken.
 */
export const exportProductsCsv = (query: ProductExportQuery) =>
  requestBlob('/products/export.csv', { query });

export const getPriceHistory = (
  id: string,
  query: { from?: string; to?: string; interval?: PriceHistoryInterval },
  signal?: AbortSignal,
) => request<PricePoint[]>(`/products/${id}/price-history`, { query, signal });

export const listKeywords = (signal?: AbortSignal) =>
  request<Keyword[]>('/keywords', { signal });

export const createKeyword = (body: CreateKeywordInput) =>
  request<Keyword>('/keywords', { method: 'POST', body });

/** Paste a list. Existing terms are skipped, not rejected — see the result shape. */
export const bulkCreateKeywords = (keywords: string[], niche?: string) =>
  request<BulkCreateKeywordsResult>('/keywords/bulk', { method: 'POST', body: { keywords, niche } });

export const updateKeyword = (id: string, body: UpdateKeywordInput) =>
  request<Keyword>(`/keywords/${id}`, { method: 'PATCH', body });

export const deleteKeyword = (id: string) =>
  request<void>(`/keywords/${id}`, { method: 'DELETE' });

export const listCrawlJobs = (signal?: AbortSignal) =>
  request<CrawlJob[]>('/crawl-jobs', { signal });

export const getCrawlJob = (id: string, signal?: AbortSignal) =>
  request<CrawlJob>(`/crawl-jobs/${id}`, { signal });

export const createCrawlJob = (body: CreateCrawlJobInput) =>
  request<CrawlJob>('/crawl-jobs', { method: 'POST', body });

/** PATCH has existed on the API since the start; nothing called it until jobs became editable. */
export const updateCrawlJob = (id: string, body: UpdateCrawlJobInput) =>
  request<CrawlJob>(`/crawl-jobs/${id}`, { method: 'PATCH', body });

export const deleteCrawlJob = (id: string) =>
  request<void>(`/crawl-jobs/${id}`, { method: 'DELETE' });

/**
 * Returns an ARRAY: a sweep queues one run per keyword it tracks.
 *
 * Note the response type here is hand-written, not derived from the generated
 * schema — `request<T>` takes it on trust. So when the API changed from one run to
 * many, nothing failed to compile; it would just have handed an array to code
 * expecting an object. Keep this in sync by hand.
 */
export const triggerCrawl = (jobId: string) =>
  request<CrawlRun[]>(`/crawl-jobs/${jobId}/run`, { method: 'POST' });

export const listCrawlRuns = (query: CrawlRunListQuery, signal?: AbortSignal) =>
  request<PaginatedCrawlRuns>('/crawl-runs', { query, signal });

export const cancelCrawlRun = (id: string) =>
  request<CrawlRun>(`/crawl-runs/${id}/cancel`, { method: 'POST' });

export const getStatsOverview = (signal?: AbortSignal) =>
  request<StatsOverview>('/stats/overview', { signal });
