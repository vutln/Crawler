import type { CrawlRunListQuery, ProductListQuery } from '@/types';

/** Hierarchical: invalidating a prefix nukes every filtered variant beneath it. */
export const queryKeys = {
  products: {
    all: ['products'] as const,
    list: (q: ProductListQuery) => ['products', 'list', q] as const,
    detail: (id: string) => ['products', 'detail', id] as const,
    priceHistory: (id: string, range: string) =>
      ['products', 'detail', id, 'price-history', range] as const,
  },
  keywords: {
    all: ['keywords'] as const,
    list: () => ['keywords', 'list'] as const,
  },
  crawlJobs: {
    all: ['crawl-jobs'] as const,
    list: () => ['crawl-jobs', 'list'] as const,
    detail: (id: string) => ['crawl-jobs', 'detail', id] as const,
  },
  crawlRuns: {
    all: ['crawl-runs'] as const,
    list: (q: CrawlRunListQuery) => ['crawl-runs', 'list', q] as const,
  },
  stats: {
    overview: ['stats', 'overview'] as const,
  },
} as const;
