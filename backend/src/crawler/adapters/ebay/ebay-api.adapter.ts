import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Marketplace } from '../../../generated/prisma/client';
import { cleanText, normalizeCurrency } from '../../normalize';
import { ThrottleService } from '../../politeness/throttle.service';
import type {
  CrawlContext,
  MarketplaceAdapter,
  ProductRecord,
} from '../adapter.interface';

interface EbayItemSummary {
  itemId: string;
  legacyItemId?: string;
  title: string;
  itemWebUrl: string;
  price?: { value: string; currency: string };
  image?: { imageUrl: string };
  seller?: { username: string; feedbackScore?: number };
  condition?: string;
  brand?: string;
}

/**
 * eBay via the official Browse API.
 *
 * This class is the proof that MarketplaceAdapter is the right abstraction:
 * it implements the identical interface as EbaySeleniumAdapter, emits the same
 * ProductRecord, and never opens a browser. The pipeline cannot tell the
 * difference — but this path is faster, sanctioned, and doesn't get blocked.
 *
 * priority 100 > the Selenium adapter's 10, so this wins whenever credentials
 * are present. With no credentials isAvailable() returns false and the registry
 * silently falls back to scraping — which is why the app works out of the box.
 */
@Injectable()
export class EbayApiAdapter implements MarketplaceAdapter {
  readonly marketplace = Marketplace.EBAY;
  readonly name = 'ebay-api';
  readonly priority = 100;
  readonly capabilities = { search: true, productDetail: true };

  private readonly logger = new Logger(EbayApiAdapter.name);
  private readonly appId?: string;
  private readonly certId?: string;

  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly config: ConfigService,
    private readonly throttle: ThrottleService,
  ) {
    this.appId = this.config.get<string>('EBAY_APP_ID');
    this.certId = this.config.get<string>('EBAY_CERT_ID');
  }

  isAvailable(): boolean {
    return Boolean(this.appId && this.certId);
  }

  async *search(ctx: CrawlContext): AsyncIterable<ProductRecord> {
    if (!ctx.query) throw new Error('eBay search requires a query');

    const pageSize = Math.min(200, ctx.maxItems);
    let emitted = 0;

    for (let page = 0; page < ctx.maxPages; page++) {
      if (ctx.signal.aborted || emitted >= ctx.maxItems) return;

      const url =
        `https://api.ebay.com/buy/browse/v1/item_summary/search` +
        `?q=${encodeURIComponent(ctx.query)}&limit=${pageSize}&offset=${page * pageSize}`;

      const body = await this.request<{ itemSummaries?: EbayItemSummary[] }>(url, ctx);
      const items = body.itemSummaries ?? [];
      if (items.length === 0) return;

      for (const item of items) {
        if (emitted >= ctx.maxItems) return;
        yield this.toRecord(item);
        emitted++;
      }
    }
  }

  async fetchProduct(url: string, ctx: CrawlContext): Promise<ProductRecord | null> {
    const legacyId = /\/itm\/(?:[^/]+\/)?(\d{9,15})/.exec(url)?.[1];
    if (!legacyId) throw new Error(`Not an eBay item URL: ${url}`);

    const apiUrl =
      `https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id` +
      `?legacy_item_id=${legacyId}`;

    try {
      const item = await this.request<EbayItemSummary>(apiUrl, ctx);
      return this.toRecord(item);
    } catch (err) {
      if ((err as Error).message.includes('404')) return null;
      throw err;
    }
  }

  private toRecord(item: EbayItemSummary): ProductRecord {
    return {
      // Prefer the legacy id: it's what appears in /itm/<id> URLs, so records
      // collected via the API and via scraping dedup onto the same natural key
      // instead of creating two rows for one product.
      externalId: item.legacyItemId ?? item.itemId,
      url: item.itemWebUrl,
      title: cleanText(item.title),
      price: item.price ? Number.parseFloat(item.price.value) : null,
      currency: normalizeCurrency(item.price?.currency),
      inStock: Boolean(item.price),
      imageUrl: item.image?.imageUrl,
      seller: item.seller?.username,
      brand: item.brand,
      raw: item,
    };
  }

  private async request<T>(url: string, ctx: CrawlContext): Promise<T> {
    await this.throttle.acquire(url, ctx.signal);

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        Accept: 'application/json',
      },
      signal: ctx.signal,
    });

    if (!res.ok) {
      this.throttle.recordFailure(url);
      throw new Error(`eBay API ${res.status}: ${cleanText(await res.text(), 300)}`);
    }

    this.throttle.recordSuccess(url);
    return (await res.json()) as T;
  }

  /** Client-credentials token, cached with a 60s safety margin. */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;

    const basic = Buffer.from(`${this.appId}:${this.certId}`).toString('base64');

    const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'https://api.ebay.com/oauth/api_scope',
      }),
    });

    if (!res.ok) {
      throw new Error(`eBay OAuth failed (${res.status}): check EBAY_APP_ID / EBAY_CERT_ID`);
    }

    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in - 60) * 1000,
    };
    this.logger.log('Obtained eBay OAuth token');
    return this.token.value;
  }
}
