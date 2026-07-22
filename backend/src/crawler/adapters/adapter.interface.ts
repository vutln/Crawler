import type { LoggerService } from '@nestjs/common';
import type { Marketplace } from '../../generated/prisma/client';

/**
 * A single product observation, normalized across marketplaces.
 * Adapters emit these; the pipeline knows nothing about where they came from.
 */
export interface ProductRecord {
  /** ASIN / Etsy listing id / eBay item id. Half of the natural key. */
  externalId: string;
  url: string;
  title: string;
  /** null when the listing has no resolvable price — never 0. */
  price: number | null;
  /**
   * ISO-4217, uppercase, or null when the currency could not be determined.
   *
   * Null is not the same as USD, and the runner will refuse to store a price
   * carrying a null currency rather than guess one. See normalizeCurrency.
   */
  currency: string | null;
  inStock: boolean;
  /**
   * Optional fields mean "this adapter did not look", NOT "there was nothing
   * there" — the runner relies on that distinction to avoid overwriting a value
   * another adapter collected. Leave a field `undefined` rather than passing
   * null when your source has no such concept (see ebay-api and reviewCount).
   */
  imageUrl?: string;
  rating?: number;
  reviewCount?: number;
  seller?: string;
  brand?: string;
  /** Adapter-specific payload, kept for debugging bad parses. */
  raw?: unknown;
}

export interface CrawlContext {
  query?: string;
  urls?: string[];
  maxPages: number;
  maxItems: number;
  /** Adapters must check this between pages. */
  signal: AbortSignal;
  logger: LoggerService;
  diagnosticLabel?: string;
}

/**
 * The extension seam. Deliberately mentions no browser, driver, DOM or HTTP:
 * it abstracts *obtaining product data*, so an official-API adapter and a
 * Selenium one are interchangeable and the pipeline can't tell them apart.
 *
 * Adding a marketplace = implement this + register the class.
 */
export interface MarketplaceAdapter {
  readonly marketplace: Marketplace;

  /** Distinguishes 'ebay-api' from 'ebay-selenium' in logs. */
  readonly name: string;

  /** Highest available wins, letting an official API outrank scraping. */
  readonly priority: number;

  readonly capabilities: {
    search: boolean;
    productDetail: boolean;
  };

  /** False when unusable right now — e.g. an API adapter with no credentials. */
  isAvailable(): boolean;

  /**
   * A generator, not Promise<ProductRecord[]>: lets the pipeline persist
   * incrementally, honour maxItems without over-fetching, and abort mid-crawl.
   */
  search(ctx: CrawlContext): AsyncIterable<ProductRecord>;

  fetchProduct(url: string, ctx: CrawlContext): Promise<ProductRecord | null>;
}

/** Multi-injection token. Every adapter registers against it. */
export const MARKETPLACE_ADAPTER = Symbol('MARKETPLACE_ADAPTER');

/** Thrown when an adapter detects an anti-bot wall. Surfaced as RunStatus.BLOCKED. */
export class BlockedError extends Error {
  constructor(
    message: string,
    readonly evidence?: string,
    /**
     * How long this host is owed before it is worth knocking again.
     *
     * Carried on the error because only the adapter knows which HOST was walled —
     * the queue sees a run id and a status, and the throttle keys on hostname. Ask
     * a marketplace-to-origin map to live in the queue and you have duplicated
     * adapter knowledge in the one place that was designed not to have it.
     *
     * The queue uses this to wait out a cooldown instead of stampeding the rest of
     * the batch through it — see InMemoryCrawlQueue.drain.
     */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'BlockedError';
  }
}
