/**
 * The only file that imports the generated schema. Everything else imports from
 * here, so how types are produced stays swappable.
 *
 * Regenerate with `npm run gen:api` (backend must be running).
 */
import type { components, operations } from '@/api/generated/schema';

export type Marketplace = components['schemas']['Marketplace'];
export type CrawlJobType = components['schemas']['CrawlJobType'];
export type RunStatus = components['schemas']['RunStatus'];
export type RunTrigger = components['schemas']['RunTrigger'];
export type ProductSortBy = components['schemas']['ProductSortBy'];
export type SortOrder = components['schemas']['SortOrder'];

export type Product = components['schemas']['ProductDto'];
export type PaginatedProducts = components['schemas']['PaginatedProductsDto'];
export type PricePoint = components['schemas']['PricePointDto'];
export type CrawlJob = components['schemas']['CrawlJobDto'];
export type CrawlRun = components['schemas']['CrawlRunDto'];
export type PaginatedCrawlRuns = components['schemas']['PaginatedCrawlRunsDto'];
export type CreateCrawlJobInput = components['schemas']['CreateCrawlJobDto'];
export type UpdateCrawlJobInput = components['schemas']['UpdateCrawlJobDto'];
export type Keyword = components['schemas']['KeywordDto'];
export type CreateKeywordInput = components['schemas']['CreateKeywordDto'];
export type UpdateKeywordInput = components['schemas']['UpdateKeywordDto'];
export type BulkCreateKeywordsResult = components['schemas']['BulkCreateKeywordsResultDto'];
export type StatsOverview = components['schemas']['StatsOverviewDto'];
export type MarketplaceStat = components['schemas']['MarketplaceStatDto'];

// Renaming a controller method breaks these loudly, here, in one file.
export type ProductListQuery = NonNullable<operations['ProductsController_list']['parameters']['query']>;
/**
 * The list query minus paging — the backend derives it from ListProductsDto via
 * OmitType, so it tracks every filter automatically. Taken from the generated
 * operation rather than hand-written for exactly that reason.
 */
export type ProductExportQuery = NonNullable<
  operations['ProductsController_exportCsv']['parameters']['query']
>;

export type CrawlJobListQuery = NonNullable<operations['CrawlJobsController_findAll']['parameters']['query']>

export type CrawlRunListQuery = NonNullable<operations['CrawlRunsController_list']['parameters']['query']>;

/** Hand-written: @ApiQuery on a bare param widens to `string` in the spec. */
export type PriceHistoryInterval = 'raw' | 'hour' | 'day';
