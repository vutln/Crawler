import { Injectable } from '@nestjs/common';
import { By, type WebDriver, type WebElement } from 'selenium-webdriver';
import { Marketplace } from '../../../generated/prisma/client';
import {
  canonicalUrl,
  cleanText,
  normalizeCurrency,
  parsePrice,
  parseRating,
  parseReviewCount,
} from '../../normalize';
import { SeleniumAdapterBase } from '../selenium-adapter.base';
import type { CrawlContext, ProductRecord } from '../adapter.interface';

/**
 * Etsy via Selenium.
 *
 * Etsy publishes Open API v3, which is the supported path and far steadier than
 * this. EtsyApiAdapter takes over automatically when ETSY_API_KEY is set.
 */
@Injectable()
export class EtsySeleniumAdapter extends SeleniumAdapterBase {
  readonly marketplace = Marketplace.ETSY;
  readonly name = 'etsy-selenium';

  private readonly origin = 'https://www.etsy.com';

  private readonly sel = {
    resultItem: [
      'div[data-listing-id]',
      'li.wt-list-unstyled > div.js-merch-stash-check-listing',
      'ol.wt-grid > li',
    ],
    title: ['h3[data-listing-card-listing-title]', 'h3.wt-text-caption', 'h3'],
    link: ['a.listing-link', 'a[href*="/listing/"]'],
    price: ['span.currency-value', 'p.wt-text-title-01 span.currency-value', '.n-listing-card__price'],
    currency: ['span.currency-symbol'],
    image: ['img.wt-width-full', 'img[data-listing-card-listing-image]', 'img'],
    shop: ['p.wt-text-gray span', 'span.wt-text-truncate'],
    rating: ['span[aria-label*="out of 5 stars"]', 'input[name="rating"]'],
    /**
     * These are generic Etsy typography utilities, not review hooks — they match
     * whatever text happens to sit in a body-01 span, which is why parseCard
     * screens the result through REVIEW_COUNT_SHAPE below rather than trusting it.
     *
     * Unverified against real markup: there is no Etsy fixture (test/fixtures has
     * only amazon/ and ebay/) and Etsy is currently blocking this egress, so a
     * tighter selector can't be confirmed. Capture one via `npm run fixtures:capture`
     * from an unblocked host and tighten this then.
     */
    reviews: ['span.wt-text-body-01', 'p.wt-text-caption span'],
  };

  /**
   * Etsy renders the review count parenthesised next to the stars: "(1,234)".
   *
   * Required because sel.reviews is generic enough to match unrelated card text,
   * and parseReviewCount strips non-digits — so "Ad by Shop2024" yielded 2024, a
   * confident wrong number in the right column. Anything not shaped like a count
   * is discarded. If Etsy restyles this, the field goes undefined (honest and
   * visible) rather than silently wrong.
   */
  private static readonly REVIEW_COUNT_SHAPE = /^\(\s*[\d.,]+\s*k?\s*\)$/i;

  /** Same list as sel.reviews; kept separate because reviewCountText walks ALL matches. */
  private static readonly REVIEW_CANDIDATES = ['span.wt-text-body-01', 'p.wt-text-caption span'];

  async *search(ctx: CrawlContext): AsyncIterable<ProductRecord> {
    if (!ctx.query) throw new Error('Etsy search requires a query');

    let emitted = 0;

    for (let page = 1; page <= ctx.maxPages; page++) {
      if (ctx.signal.aborted || emitted >= ctx.maxItems) return;

      const url = `${this.origin}/search?q=${encodeURIComponent(ctx.query)}&page=${page}`;

      const records = await this.drivers.withDriver(async (driver) => {
        await this.navigate(driver, url, ctx);
        return this.parseSearchPage(driver, `Etsy page ${page}`);
      });

      if (records.length === 0) return;

      for (const record of records) {
        if (emitted >= ctx.maxItems) return;
        yield record;
        emitted++;
      }
    }
  }

  /**
   * Parse whatever search page the driver currently has open.
   * Split out from search() so tests can point a driver at a frozen HTML
   * fixture and exercise the real parser offline.
   */
  protected async parseSearchPage(driver: WebDriver, context = 'Etsy'): Promise<ProductRecord[]> {
    const rendered = await this.waitForAny(driver, this.sel.resultItem);
    if (!rendered) {
      // Throws BlockedError if this is a wall rather than a genuinely empty
      // result set. Returning [] here unconditionally is what let an Etsy
      // JS challenge report SUCCEEDED / 0 items.
      await this.diagnoseEmptyPage(driver, context);
      return [];
    }

    const elements = await driver.findElements(By.css(this.sel.resultItem.join(', ')));
    const out: ProductRecord[] = [];

    for (const el of elements) {
      const record = await this.parseCard(el);
      if (record) out.push(record);
    }
    return out;
  }

  private async parseCard(el: WebElement): Promise<ProductRecord | null> {
    const href = await this.attrOf(el, this.sel.link, 'href');
    if (!href) return null;

    const listingId =
      (await el.getAttribute('data-listing-id'))?.trim() || this.extractListingId(href);
    if (!listingId) return null;

    const title = await this.textOf(el, this.sel.title);
    if (!title) return null;

    // Etsy splits the symbol and the number into separate elements, so the
    // usual "parse the whole price string" trick finds a bare number with no
    // currency. Recombine them before parsing.
    const symbol = await this.textOf(el, this.sel.currency);
    const value = await this.textOf(el, this.sel.price);
    const { price, currency } = parsePrice([symbol, value].filter(Boolean).join(''));

    return {
      externalId: listingId,
      url: canonicalUrl(href, this.origin),
      title: cleanText(title),
      price,
      currency: normalizeCurrency(currency),
      inStock: price !== null,
      imageUrl: await this.attrOf(el, this.sel.image, 'src'),
      seller: cleanText((await this.textOf(el, this.sel.shop)) ?? '', 191) || undefined,
      rating: parseRating(await this.attrOf(el, this.sel.rating, 'aria-label')),
      reviewCount: parseReviewCount(await this.reviewCountText(el)),
      raw: { symbol, value },
    };
  }

  /**
   * First candidate that actually looks like a review count, else undefined.
   *
   * Can't use textOf() alone: it returns the first NON-EMPTY match, and these
   * selectors are generic typography, so the first hit is usually shop or price
   * text. Walk the candidates and keep the one matching REVIEW_COUNT_SHAPE.
   */
  private async reviewCountText(el: WebElement): Promise<string | undefined> {
    for (const selector of EtsySeleniumAdapter.REVIEW_CANDIDATES) {
      const els = await el.findElements(By.css(selector)).catch(() => []);
      for (const candidate of els) {
        const text = (await candidate.getText().catch(() => ''))?.trim();
        if (text && EtsySeleniumAdapter.REVIEW_COUNT_SHAPE.test(text)) return text;
      }
    }
    return undefined;
  }

  async fetchProduct(url: string, ctx: CrawlContext): Promise<ProductRecord | null> {
    const listingId = this.extractListingId(url);
    if (!listingId) throw new Error(`Not an Etsy listing URL: ${url}`);

    return this.drivers.withDriver(async (driver) => {
      await this.navigate(driver, url, ctx);

      const rendered = await this.waitForAny(driver, ['h1[data-buy-box-listing-title]', 'h1']);
      if (!rendered) return null;

      const body = await driver.findElement(By.css('body'));

      const title = await this.textOf(body, ['h1[data-buy-box-listing-title]', 'h1']);
      if (!title) return null;

      const priceText = await this.textOf(body, [
        'div[data-buy-box-region="price"] p',
        'p.wt-text-title-larger',
        'span.currency-value',
      ]);
      const { price, currency } = parsePrice(priceText);

      return {
        externalId: listingId,
        url: canonicalUrl(url, this.origin),
        title: cleanText(title),
        price,
        currency: normalizeCurrency(currency),
        inStock: price !== null,
        imageUrl: await this.attrOf(body, ['img[data-src]', 'img.wt-max-width-full'], 'src'),
        seller: cleanText((await this.textOf(body, ['a[href*="/shop/"] span', 'span.wt-text-title-01'])) ?? '', 191) || undefined,
        rating: parseRating(await this.attrOf(body, ['input[name="rating"]'], 'value')),
        raw: { priceText },
      };
    });
  }

  private extractListingId(url: string): string | null {
    return /\/listing\/(\d+)/.exec(url)?.[1] ?? null;
  }
}
