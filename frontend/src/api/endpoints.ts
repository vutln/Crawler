import { request } from './http';
import type {
  CrawlJob,
  CrawlRun,
  CrawlRunListQuery,
  CreateCrawlJobInput,
  PaginatedCrawlRuns,
  PaginatedProducts,
  PricePoint,
  PriceHistoryInterval,
  Product,
  ProductListQuery,
  StatsOverview,
} from '@/types/api';

// `signal` threaded throughout so TanStack Query can cancel in-flight requests.

export const listProducts = (query: ProductListQuery, signal?: AbortSignal) =>
  request<PaginatedProducts>('/products', { query, signal });

export const getProduct = (id: string, signal?: AbortSignal) =>
  request<Product>(`/products/${id}`, { signal });

export const getPriceHistory = (
  id: string,
  query: { from?: string; to?: string; interval?: PriceHistoryInterval },
  signal?: AbortSignal,
) => request<PricePoint[]>(`/products/${id}/price-history`, { query, signal });

export const listCrawlJobs = (signal?: AbortSignal) =>
  request<CrawlJob[]>('/crawl-jobs', { signal });

export const createCrawlJob = (body: CreateCrawlJobInput) =>
  request<CrawlJob>('/crawl-jobs', { method: 'POST', body });

export const deleteCrawlJob = (id: string) =>
  request<void>(`/crawl-jobs/${id}`, { method: 'DELETE' });

export const triggerCrawl = (jobId: string) =>
  request<CrawlRun>(`/crawl-jobs/${jobId}/run`, { method: 'POST' });

export const listCrawlRuns = (query: CrawlRunListQuery, signal?: AbortSignal) =>
  request<PaginatedCrawlRuns>('/crawl-runs', { query, signal });

export const cancelCrawlRun = (id: string) =>
  request<CrawlRun>(`/crawl-runs/${id}/cancel`, { method: 'POST' });

export const getStatsOverview = (signal?: AbortSignal) =>
  request<StatsOverview>('/stats/overview', { signal });
