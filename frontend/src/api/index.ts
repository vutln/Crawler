/**
 * Barrel for the API client. Import from '@/api'.
 *
 * Two things are deliberately NOT re-exported here:
 *
 * `./generated/schema` — src/types/api.ts is the only file allowed to import it,
 * so that how types are produced stays swappable. Re-exporting it would make that
 * rule unenforceable, and would put a second path to the same types in scope.
 *
 * `./queryClient` — it constructs a QueryClient at module scope. Anything in this
 * barrel would drag that instantiation along, so a component importing one
 * endpoint would build the app's cache as a side effect. It has exactly one
 * consumer (main.tsx, the composition root), which imports it directly.
 */

// Request plumbing
export { ApiError, request, requestBlob } from './http';
export { queryKeys } from './queryKeys';

// Endpoints — products
export {
  listProducts,
  getProduct,
  exportProductsCsv,
  getPriceHistory,
} from './endpoints';

// Endpoints — keywords
export {
  listKeywords,
  createKeyword,
  bulkCreateKeywords,
  updateKeyword,
  deleteKeyword,
} from './endpoints';

// Endpoints — crawl jobs and runs
export {
  listCrawlJobs,
  getCrawlJob,
  createCrawlJob,
  updateCrawlJob,
  deleteCrawlJob,
  triggerCrawl,
  listCrawlRuns,
  cancelCrawlRun,
} from './endpoints';

// Endpoints — stats & diagnostics
export { getStatsOverview, listDiagnostics } from './endpoints';
