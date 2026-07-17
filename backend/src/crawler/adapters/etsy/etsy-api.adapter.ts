import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Marketplace } from '../../../generated/prisma/client';
import { cleanText, normalizeCurrency } from '../../normalize';
import { ThrottleService } from '../../politeness/throttle.service';
import type {
  CrawlContext,
  MarketplaceAdapter,
  ProductRecord,
} from '../adapter.interface';

interface EtsyListing {
  listing_id: number;
  title: string;
  url: string;
  price?: { amount: number; divisor: number; currency_code: string };
  quantity?: number;
  shop_id?: number;
  num_favorers?: number;
  images?: Array<{ url_570xN?: string; url_fullxfull?: string }>;
}

/**
 * Etsy via the official Open API v3.
 *
 * Same interface as EtsySeleniumAdapter, no browser. Outranks it (100 > 10)
 * whenever ETSY_API_KEY is present.
 */
@Injectable()
export class EtsyApiAdapter implements MarketplaceAdapter {
  readonly marketplace = Marketplace.ETSY;
  readonly name = 'etsy-api';
  readonly priority = 100;
  readonly capabilities = { search: true, productDetail: true };

  private readonly apiKey?: string;
  private readonly base = 'https://openapi.etsy.com/v3/application';

  constructor(
    private readonly config: ConfigService,
    private readonly throttle: ThrottleService,
  ) {
    this.apiKey = this.config.get<string>('ETSY_API_KEY');
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Items per page. Approximates Etsy's search grid rather than using the API's
   * 100 maximum, so "page N" means roughly the same on both paths.
   *
   * UNVERIFIED, unlike the eBay equivalent, and worth knowing why: ebay-selenium
   * sets its own page size (`&_ipg=60`), so parity there is exact by construction.
   * etsy-selenium requests `/search?q=…&page=N` and lets the SITE choose, so the
   * true number can only come from a real capture — and there is no Etsy fixture
   * because Etsy is currently blocking this egress.
   *
   * 64 is the closer guess (Etsy's grid is nowhere near 100), but treat it as an
   * assumption: capture a fixture via `npm run fixtures:capture -- etsy "..."` from
   * an unblocked host, count the listing cards, and correct this. Until then a
   * maxPages of 2 collects ~128 listings here, which may not be exactly the site's
   * first two pages.
   */
  private static readonly PAGE_SIZE = 64;

  async *search(ctx: CrawlContext): AsyncIterable<ProductRecord> {
    if (!ctx.query) throw new Error('Etsy search requires a query');

    // Infinity-safe: Math.min(64, Infinity) is 64. maxItems still wins when lower.
    const pageSize = Math.min(EtsyApiAdapter.PAGE_SIZE, ctx.maxItems);
    let emitted = 0;

    for (let page = 0; page < ctx.maxPages; page++) {
      if (ctx.signal.aborted || emitted >= ctx.maxItems) return;

      const url =
        `${this.base}/listings/active?keywords=${encodeURIComponent(ctx.query)}` +
        `&limit=${pageSize}&offset=${page * pageSize}&includes=Images`;

      const body = await this.request<{ results?: EtsyListing[] }>(url, ctx);
      const results = body.results ?? [];
      if (results.length === 0) return;

      for (const listing of results) {
        if (emitted >= ctx.maxItems) return;
        yield this.toRecord(listing);
        emitted++;
      }
    }
  }

  async fetchProduct(url: string, ctx: CrawlContext): Promise<ProductRecord | null> {
    const listingId = /\/listing\/(\d+)/.exec(url)?.[1];
    if (!listingId) throw new Error(`Not an Etsy listing URL: ${url}`);

    try {
      const listing = await this.request<EtsyListing>(
        `${this.base}/listings/${listingId}?includes=Images`,
        ctx,
      );
      return this.toRecord(listing);
    } catch (err) {
      if ((err as Error).message.includes('404')) return null;
      throw err;
    }
  }

  private toRecord(listing: EtsyListing): ProductRecord {
    return {
      externalId: String(listing.listing_id),
      url: listing.url,
      title: cleanText(listing.title),
      // Etsy sends money as amount/divisor (e.g. 1250/100 = 12.50) to dodge
      // float issues. Dividing here is correct; treating `amount` as the price
      // would be off by 100x.
      price: listing.price ? listing.price.amount / listing.price.divisor : null,
      currency: normalizeCurrency(listing.price?.currency_code),
      inStock: (listing.quantity ?? 0) > 0,
      imageUrl: listing.images?.[0]?.url_570xN ?? listing.images?.[0]?.url_fullxfull,
      seller: listing.shop_id ? String(listing.shop_id) : undefined,
      // reviewCount is deliberately NOT set. This used to be `listing.num_favorers`,
      // which is Etsy's favourites/hearts count — a different quantity entirely,
      // and worse than a null because it's a plausible integer sitting in the
      // right column that nothing downstream can flag as wrong.
      //
      // Etsy v3's listing object carries no review count. Real counts need
      // GET /listings/{id}/reviews per listing: ~128 extra calls per keyword per
      // day, which at the 2s throttle floor is ~4 min per keyword. Not viable for
      // a sweep, so this path reports undefined and capabilities.reviewCount says
      // so. Use etsy-selenium if review counts matter more than speed.
      raw: listing,
    };
  }

  private async request<T>(url: string, ctx: CrawlContext): Promise<T> {
    await this.throttle.acquire(url, ctx.signal);

    const res = await fetch(url, {
      headers: { 'x-api-key': this.apiKey!, Accept: 'application/json' },
      signal: ctx.signal,
    });

    if (!res.ok) {
      this.throttle.recordFailure(url);
      throw new Error(`Etsy API ${res.status}: ${cleanText(await res.text(), 300)}`);
    }

    this.throttle.recordSuccess(url);
    return (await res.json()) as T;
  }
}
