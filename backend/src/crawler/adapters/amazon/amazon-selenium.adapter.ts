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
 * Amazon via Selenium.
 *
 * Be realistic about this one: Amazon runs the most aggressive anti-bot stack of
 * the three targets and will serve CAPTCHAs to datacenter and repeat-visitor IPs.
 * Expect RunStatus.BLOCKED regularly. That is the system working — the block is
 * detected and reported rather than silently producing an empty "successful" run.
 *
 */
@Injectable()
export class AmazonSeleniumAdapter extends SeleniumAdapterBase {
  readonly marketplace = Marketplace.AMAZON;
  readonly name = 'amazon-selenium';

  private readonly origin = 'https://www.amazon.com';

  private readonly sel = {
    resultItem: ['div[data-asin][data-component-type="s-search-result"]'],
    title: ['h2 a span', 'h2 span', '.a-size-medium.a-color-base.a-text-normal'],
    link: ['h2 a.a-link-normal', 'a.a-link-normal.s-no-outline', 'a.a-link-normal'],
    // Amazon renders price split across spans; .a-offscreen holds the whole
    // string for screen readers and is by far the most stable hook.
    price: ['.a-price .a-offscreen', 'span.a-price > span.a-offscreen', '.a-color-price'],
    image: ['img.s-image'],
    rating: ['[data-cy="reviews-ratings-slot"] span.a-icon-alt', 'span.a-icon-alt'],
    reviews: ['[data-csa-c-func-deps="aui-da-a-popover"] span', 'span.a-size-base.s-underline-text'],
    brand: ['h5.s-line-clamp-1 span', '.a-row.a-size-base.a-color-secondary h5'],
  };

  async *search(ctx: CrawlContext): AsyncIterable<ProductRecord> {
    const query = ctx.query;

    if (!query) {
      throw new Error('Amazon search requires a query');
    }

    const records = await this.drivers.withDriver(async (driver) => {
      const collected: ProductRecord[] = [];

      for (let page = 1; page <= ctx.maxPages; page++) {
        if (ctx.signal.aborted || collected.length >= ctx.maxItems) {
          break;
        }

        const url = `${this.origin}/s?k=${encodeURIComponent(query)}&page=${page}`;

        await this.navigate(driver, url, ctx);

        const pageRecords = await this.parseSearchPage(
          driver,
          `Amazon page ${page}`,
        );

        if (pageRecords.length === 0) {
          break;
        }

        for (const record of pageRecords) {
          collected.push(record);

          if (collected.length >= ctx.maxItems) {
            break;
          }
        }
      }

      return collected;
    });

    for (const record of records) {
      yield record;
    }
  }

  /**
   * Parse whatever search page the driver currently has open.
   * Split out from search() so tests can point a driver at a captured HTML
   * fixture and exercise the real parser offline.
   */
  protected async parseSearchPage(driver: WebDriver, context = 'Amazon'): Promise<ProductRecord[]> {
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
    // The ASIN is on the container itself — more reliable than parsing the href.
    const asin = (await el.getAttribute('data-asin'))?.trim();
    if (!asin) return null;

    const title = await this.textOf(el, this.sel.title);
    if (!title) return null;

    const href = await this.attrOf(el, this.sel.link, 'href');
    const priceText = await this.textOf(el, this.sel.price);
    const { price, currency } = parsePrice(priceText);

    return {
      externalId: asin,
      // /dp/<asin> is the canonical form; search hrefs carry heavy tracking noise.
      url: href ? canonicalUrl(href, this.origin) : `${this.origin}/dp/${asin}`,
      title: cleanText(title),
      price,
      currency: normalizeCurrency(currency),
      // A search card with a price is purchasable; true stock needs the detail page.
      inStock: price !== null,
      imageUrl: await this.attrOf(el, this.sel.image, 'src'),
      rating: parseRating(await this.textOf(el, this.sel.rating)),
      reviewCount: parseReviewCount(await this.textOf(el, this.sel.reviews)),
      brand: cleanText((await this.textOf(el, this.sel.brand)) ?? '', 191) || undefined,
      raw: { priceText },
    };
  }

  async fetchProduct(url: string, ctx: CrawlContext): Promise<ProductRecord | null> {
    const asin = this.extractAsin(url);
    if (!asin) throw new Error(`Could not extract ASIN from ${url}`);

    return this.drivers.withDriver(async (driver) => {
      await this.navigate(driver, url, ctx);

      const rendered = await this.waitForAny(driver, ['#productTitle', '#dp-container']);
      if (!rendered) return null;

      const body = await driver.findElement(By.css('body'));

      const title = await this.textOf(body, ['#productTitle']);
      if (!title) return null;

      const priceText = await this.textOf(body, [
        '#corePrice_feature_div .a-offscreen',
        '.priceToPay .a-offscreen',
        '#price_inside_buybox',
        '.a-price .a-offscreen',
      ]);
      const { price, currency } = parsePrice(priceText);

      const availability = await this.textOf(body, ['#availability span', '#availability']);

      return {
        externalId: asin,
        url: `${this.origin}/dp/${asin}`,
        title: cleanText(title),
        price,
        currency: normalizeCurrency(currency),
        inStock:
          price !== null &&
          !/currently unavailable|out of stock/i.test(availability ?? ''),
        imageUrl: await this.attrOf(body, ['#landingImage', '#imgBlkFront'], 'src'),
        rating: parseRating(await this.textOf(body, ['#acrPopover .a-icon-alt', 'span.a-icon-alt'])),
        reviewCount: parseReviewCount(await this.textOf(body, ['#acrCustomerReviewText'])),
        brand: cleanText((await this.textOf(body, ['#bylineInfo'])) ?? '', 191) || undefined,
        seller: cleanText((await this.textOf(body, ['#sellerProfileTriggerId'])) ?? '', 191) || undefined,
        raw: { priceText, availability },
      };
    });
  }

  private extractAsin(url: string): string | null {
    return (
      /\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i.exec(url)?.[1]?.toUpperCase() ?? null
    );
  }
}
