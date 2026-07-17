import { Injectable } from '@nestjs/common';
import { By, type WebDriver, type WebElement } from 'selenium-webdriver';
import { Marketplace } from '../../../generated/prisma/client';
import {
  canonicalUrl,
  cleanText,
  normalizeCurrency,
  parsePrice,
  parseReviewCount,
} from '../../normalize';
import { SeleniumAdapterBase } from '../selenium-adapter.base';
import type { CrawlContext, ProductRecord } from '../adapter.interface';

/**
 * eBay via Selenium.
 *
 * eBay is the most permissive of the three targets and therefore the best one to
 * smoke-test the pipeline against. If you have API credentials, EbayApiAdapter
 * outranks this one automatically — see adapter.registry.ts.
 */
@Injectable()
export class EbaySeleniumAdapter extends SeleniumAdapterBase {
  readonly marketplace = Marketplace.EBAY;
  readonly name = 'ebay-selenium';

  private readonly origin = 'https://www.ebay.com';

  /**
   * Selector lists, not single selectors: eBay A/B-tests its markup constantly
   * and runs several layouts concurrently. First match wins, so a layout change
   * degrades one field instead of killing the run.
   */
  private readonly sel = {
    resultItem: ['li.s-item', 'li.s-card', 'ul.srp-results > li[data-viewport]'],
    title: ['.s-item__title', '.s-card__title', 'h3.s-item__title', '[role="heading"]'],
    price: ['.s-item__price', '.s-card__price'],
    link: ['a.s-item__link', 'a.s-card__link', 'a[href*="/itm/"]'],
    /**
     * `img.s-card__image`, NOT `.s-card__image img`.
     *
     * s-card__image is the class ON the <img>, not a wrapper around one, so the
     * descendant form searched for an <img> inside an <img> and matched nothing.
     * With the two s-item entries already extinct, all three selectors were dead
     * and eBay was collecting ZERO images — a required field — silently, because
     * imageUrl is optional and nothing asserted it. Verified against
     * test/fixtures/ebay/search-live.html: 112 of 114 carry a real i.ebayimg.com
     * src. (The other 2 are the "Shop on eBay" promo rows, which parseCard drops
     * by title anyway.)
     */
    image: ['img.s-card__image', '.s-item__image-wrapper img', 'img.s-item__image-img'],
    seller: ['.s-item__seller-info-text', '.s-card__seller-info'],
    reviews: ['.s-item__reviews-count', '.s-card__reviews-count'],
    subtitle: ['.s-item__subtitle', '.s-card__subtitle'],
    nextPage: ['a.pagination__next[href]', 'a[type="next"][href]'],
  };

  async *search(ctx: CrawlContext): AsyncIterable<ProductRecord> {
    if (!ctx.query) throw new Error('eBay search requires a query');

    let emitted = 0;

    for (let page = 1; page <= ctx.maxPages; page++) {
      if (ctx.signal.aborted || emitted >= ctx.maxItems) return;

      const url =
        `${this.origin}/sch/i.html?_nkw=${encodeURIComponent(ctx.query)}` +
        `&_pgn=${page}&_ipg=60`;

      // One driver per page, not one per run: a long crawl holding a browser open
      // accumulates memory and detached DOM, and a crash mid-run leaks it.
      const records = await this.drivers.withDriver(async (driver) => {
        await this.navigate(driver, url, ctx);
        return this.parseSearchPage(driver, `eBay page ${page}`);
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
   *
   * Split out from search() so tests can point a driver at a frozen HTML fixture
   * and exercise the real parser without touching live eBay. Everything below
   * this line is pure DOM -> ProductRecord and knows nothing about navigation.
   */
  protected async parseSearchPage(driver: WebDriver, context = 'eBay'): Promise<ProductRecord[]> {
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

  /** Returns null for non-product rows (ads, "results matching fewer words" separators). */
  private async parseCard(el: WebElement): Promise<ProductRecord | null> {
    const href = await this.attrOf(el, this.sel.link, 'href');
    if (!href) return null;

    const externalId = this.extractItemId(href);
    if (!externalId) return null;

    const rawTitle = await this.textOf(el, this.sel.title);
    if (!rawTitle) return null;

    // eBay prefixes some titles with this for screen readers.
    const title = cleanText(rawTitle.replace(/^New Listing/i, '').trim());
    if (!title || /^shop on ebay$/i.test(title)) return null;

    const priceText = await this.textOf(el, this.sel.price);
    const { price, currency } = parsePrice(priceText);

    const imageUrl = await this.attrOf(el, this.sel.image, 'src');
    const sellerText = await this.textOf(el, this.sel.seller);
    const reviewsText = await this.textOf(el, this.sel.reviews);
    const subtitle = await this.textOf(el, this.sel.subtitle);

    return {
      externalId,
      url: canonicalUrl(href, this.origin),
      title,
      price,
      currency: normalizeCurrency(currency),
      // eBay search cards don't reliably expose stock; a priced listing is live.
      inStock: price !== null && !/sold\s*out/i.test(subtitle ?? ''),
      imageUrl,
      seller: sellerText ? cleanText(sellerText.split('(')[0], 191) : undefined,
      reviewCount: parseReviewCount(reviewsText),
      raw: { priceText, subtitle },
    };
  }

  async fetchProduct(url: string, ctx: CrawlContext): Promise<ProductRecord | null> {
    const externalId = this.extractItemId(url);
    if (!externalId) throw new Error(`Not an eBay item URL: ${url}`);

    return this.drivers.withDriver(async (driver) => {
      await this.navigate(driver, url, ctx);

      const rendered = await this.waitForAny(driver, ['h1.x-item-title__mainTitle', 'h1']);
      if (!rendered) return null;

      const body = await driver.findElement(By.css('body'));

      const title = await this.textOf(body, ['h1.x-item-title__mainTitle span', 'h1 span', 'h1']);
      if (!title) return null;

      const priceText = await this.textOf(body, [
        '.x-price-primary span',
        '[data-testid="x-price-primary"] span',
        '#prcIsum',
      ]);
      const { price, currency } = parsePrice(priceText);

      const availability = await this.textOf(body, [
        '.x-quantity__availability',
        '#qtySubTxt',
      ]);

      return {
        externalId,
        url: canonicalUrl(url, this.origin),
        title: cleanText(title),
        price,
        currency: normalizeCurrency(currency),
        inStock: price !== null && !/out of stock|sold out/i.test(availability ?? ''),
        imageUrl: await this.attrOf(body, ['.ux-image-carousel-item img', '#icImg'], 'src'),
        seller: cleanText(
          (await this.textOf(body, ['.x-sellercard-atf__info__about-seller a', '.mbg-nw'])) ?? '',
          191,
        ) || undefined,
        raw: { priceText, availability },
      };
    });
  }

  /** eBay item ids are the 12-digit run in /itm/<id> or /itm/<slug>/<id>. */
  private extractItemId(url: string): string | null {
    return /\/itm\/(?:[^/]+\/)?(\d{9,15})/.exec(url)?.[1] ?? null;
  }
}
