import { Injectable } from '@nestjs/common';
import { By, until, type WebDriver, type WebElement } from 'selenium-webdriver';
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
 * How long to wait for the nav to render before believing the location widget
 * really is absent.
 *
 * Amazon injects the nav with JS (its own `nav-progressive-*` classes), and
 * driver.get() resolves before that runs — so this is a rendering wait, not a
 * network one. Matches the timeout the zip input already used; the gate simply
 * did not have one.
 */
const WIDGET_TIMEOUT_MS = 15_000;

// There is deliberately no homepage-retry constant here any more. The address flow
// used to load https://www.amazon.com/ up to twice looking for the nav widget, and
// that page is the most aggressively challenged on the site — measured serving a
// 2KB AWS WAF page while a search for the same session returned 1.7MB of results.
// The widget is global, so the flow now uses whichever page the crawl already
// wanted, and the retry has nothing left to do.

/**
 * Amazon pads the location label with zero-width marks — the value read back was
 * literally "Holtsville 00501" plus a ZERO WIDTH NON-JOINER, so a plain
 * includes() against the ZIP fails on a label that is in fact correct.
 *
 * Built from char codes rather than written as a regex literal: invisible
 * characters in source are unreviewable, and lint rejects them outright.
 */
const ZERO_WIDTH = new RegExp(
  // Alternation, not a character class: ZWJ (200D) inside a class can combine with
  // its neighbours into a single grapheme, which lint flags as misleading and which
  // would not match the marks individually anyway.
  [0x200b, 0x200c, 0x200d, 0xfeff].map((c) => String.fromCharCode(c)).join('|'),
  'g',
);

const stripZeroWidth = (s: string): string => s.replace(ZERO_WIDTH, '');

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

  // ConfigService is inherited from SeleniumAdapterBase, which injects it for the
  // block-reload knobs. Re-declaring it here shadowed the base's property.

  private readonly sel = {
    resultItem: ['div[data-asin][data-component-type="s-search-result"]'],
    title: [
      'h2 a span',
      'h2 span',
      '.a-size-medium.a-color-base.a-text-normal',
    ],
    link: [
      'h2 a.a-link-normal',
      'a.a-link-normal.s-no-outline',
      'a.a-link-normal',
    ],
    // Amazon renders price split across spans; .a-offscreen holds the whole
    // string for screen readers and is by far the most stable hook.
    price: [
      '.a-price .a-offscreen',
      'span.a-price > span.a-offscreen',
      '.a-color-price',
    ],
    image: ['img.s-image'],
    rating: [
      '[data-cy="reviews-ratings-slot"] span.a-icon-alt',
      'span.a-icon-alt',
    ],
    /**
     * Read as an ATTRIBUTE (aria-label), not text — see parseCard.
     *
     * Amazon labels the review-count link `aria-label="1,648 ratings"`, which is
     * both stable and unambiguous. Verified against test/fixtures/amazon/search.html.
     *
     * What was here before was actively wrong in two ways. The first selector,
     * `[data-csa-c-func-deps="aui-da-a-popover"] span`, is the RATING popover, and
     * textOf returns its first non-empty node — "4.5 out of 5 stars" — which
     * parseReviewCount stripped to 455. The second, `span.a-size-base.s-underline-text`,
     * matches nothing at all: `s-underline-text` is on the <a>, not on a span with
     * a-size-base. So every Amazon reviewCount was either 455-shaped garbage or absent.
     *
     * `$=` and not `*=`: the rating link is labelled "...stars, rating details",
     * which contains "rating" but does not end in it.
     */
    reviews: ['a[aria-label$="ratings"]', 'a[aria-label$="rating"]'],
    brand: [
      'h5.s-line-clamp-1 span',
      '.a-row.a-size-base.a-color-secondary h5',
    ],
    /**
     * The "Deliver to ..." location widget in the nav bar — see ensureDeliveryAddress.
     *
     * Amazon ships several nav variants, so each step lists fallbacks and the flow
     * treats a miss as "couldn't set it" rather than an error. GLUX = Amazon's
     * internal name for this widget; the ids have been stable for years but are
     * exactly the kind of thing the canary tier exists to catch drifting.
     */
    locationLink: ['#nav-global-location-popover-link', '#glow-ingress-line2'],
    zipInput: ['#GLUXZipUpdateInput'],
    zipApply: [
      '#GLUXZipUpdate input',
      'input[aria-labelledby="GLUXZipUpdate-announce"]',
      '#GLUXZipUpdate-announce',
    ],
    // Amazon sometimes auto-closes the popover, so this legitimately finds nothing.
    zipConfirm: [
      '#GLUXConfirmClose',
      'button[name="glowDoneButton"]',
      '.a-popover-footer .a-button-input',
    ],
    /** Reads back what Amazon thinks our address is — the only honest confirmation. */
    locationLabel: ['#glow-ingress-line2'],
  };

  /**
   * Browsers that have already been told where we want things delivered.
   *
   * Weak so a quit driver doesn't pin this entry: WebDriverFactory builds a fresh
   * browser per withDriver() call, and a Set would grow one dead key per crawl.
   */
  private readonly addressed = new WeakSet<WebDriver>();

  /** Read lazily — @Inject properties are not populated during construction. */
  private get deliveryZip(): string {
    return this.config.get<string>('AMAZON_DELIVERY_ZIP', '').trim();
  }

  /**
   * Tell Amazon where we want things delivered, once per browser.
   *
   * Amazon hides the price on any listing it cannot ship to the session's delivery
   * address, and with no address it infers one from the egress IP. From a non-US
   * egress that means a share of listings parse perfectly — title, rating, review
   * count — with no price at all, and land as price: null, currency: XXX. Honest,
   * but not the US price the requirement asks for.
   *
   * This is a preference, not a disguise. Amazon offers this widget to every
   * anonymous visitor, we drive it in our own session as ourselves, and nothing we
   * claim about what we are changes. Same category as i18n-prefs=USD, and the same
   * reason: the US store has to be told it is serving a US shopper. It is the
   * delivery half of what that cookie only does the currency half of.
   *
   * It has to be done this way because — unlike the currency — the address is NOT a
   * cookie and so cannot be seeded via CRAWL_COOKIES_JSON. Amazon holds it
   * server-side against the session, which is why a browser that never visits the
   * widget never has one.
   *
   * Best-effort on purpose. Failing to set it costs prices on non-shippable items,
   * which is exactly the status quo, so it warns and carries on rather than failing
   * a run that would otherwise collect fine. A BlockedError from navigate() still
   * propagates — a wall is never best-effort.
   */
  private async ensureDeliveryAddress(
    driver: WebDriver,
    ctx: CrawlContext,
    /** The page we are already on; reloaded after applying so it re-prices. */
    currentUrl: string,
  ): Promise<void> {
    const zip = this.deliveryZip;
    if (!zip || this.addressed.has(driver)) return;

    // Mark BEFORE attempting, not after. On failure this must not re-run for every
    // page of the crawl — that would multiply requests against a site that may
    // already be refusing us, which is how a soft block becomes a hard one.
    this.addressed.add(driver);

    try {
      /**
       * Drive the widget on the page we are ALREADY on — never the homepage.
       *
       * The nav bar is global, so the search page carries the same location widget
       * as the homepage. Measured 2026-07-20, same browser, alternating loads:
       *
       *   homepage     nav=0  waf=Y  len=  1,995   <- AWS WAF challenge
       *   search page  nav=1  waf=n  len=1,701,704
       *
       * The homepage is the single most-challenged page on the site, and the
       * previous version went there deliberately, twice, before every crawl — so
       * the address silently failed to apply on exactly the runs where the search
       * itself was working fine. Using the page we needed anyway removes both the
       * extra requests and the most likely point of failure.
       *
       * Still waits rather than looking once: the nav is progressively rendered
       * (Amazon's own `nav-progressive-*` classes), so it exists a beat after
       * driver.get() resolves.
       */
      if (
        !(await this.waitForAny(
          driver,
          this.sel.locationLink,
          WIDGET_TIMEOUT_MS,
        )) ||
        !(await this.clickFirst(driver, this.sel.locationLink))
      ) {
        this.logger.warn(
          `Delivery address not set to ${zip}: no location widget on ${currentUrl}. ` +
            `Prices will be missing for items that don't ship to this egress.`,
        );
        return;
      }

      const input = await driver.wait(
        until.elementLocated(By.css(this.sel.zipInput.join(', '))),
        15_000,
      );
      await driver.wait(until.elementIsVisible(input), 10_000);
      await input.clear();
      await input.sendKeys(zip);

      await this.clickFirst(driver, this.sel.zipApply);
      await driver.sleep(2_000);
      await this.clickFirst(driver, this.sel.zipConfirm);
      await driver.sleep(1_000);

      /**
       * Reload the page we are on. This does two jobs at once.
       *
       * PRICES: the page currently in the browser was rendered before the address
       * existed, so its prices are the ones we came for and are still wrong. It has
       * to be fetched again either way.
       *
       * VERIFICATION: measured 2026-07-20, Apply lands server-side against the
       * session but the nav label does NOT re-render for it. Immediately after
       * applying, the widget still read "Vietnam"; the very next page load read
       * "Holtsville 00501". So an in-place read-back could only ever report the
       * location we arrived with — it called every success a failure, which is
       * exactly the "it doesn't choose anything" symptom, while the address was in
       * fact set.
       *
       * Reloading the search page rather than the homepage means the reload we
       * already owe for prices is also the one that tells us the truth.
       */
      await this.navigate(driver, currentUrl, ctx);

      const body = await driver.findElement(By.css('body'));
      const shown = (await this.textOf(body, this.sel.locationLabel))?.replace(
        /\s+/g,
        ' ',
      );

      // Amazon pads the label with a zero-width non-joiner — the observed value was
      // literally "Holtsville 00501" — so strip zero-width marks before
      // comparing. Escapes, not the characters themselves: invisible regex contents
      // are unreviewable and lint rejects them outright.
      if (stripZeroWidth(shown ?? '').includes(zip)) {
        this.logger.log(
          `Delivery address set to ${zip} ("${shown}") — US pricing`,
        );
      } else {
        this.logger.warn(
          `Delivery address may not have applied: widget reads "${shown ?? '(absent)'}", ` +
            `expected it to name ${zip}. Prices for items that don't ship there stay missing.`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Could not set delivery address to ${zip}: ${(err as Error).message}. ` +
          `Continuing — items that don't ship to this egress will have no price.`,
      );
    }
  }

  /** First selector with a clickable match. False when none can be clicked. */
  private async clickFirst(
    driver: WebDriver,
    selectors: string[],
  ): Promise<boolean> {
    for (const selector of selectors) {
      for (const el of await driver.findElements(By.css(selector))) {
        try {
          await el.click();
          return true;
        } catch {
          continue; // covered by another element, or detached mid-render
        }
      }
    }
    return false;
  }

  /**
   * ONE browser for the whole run, and records streamed as each page is parsed.
   *
   * The single browser is not a preference: the delivery address lives server-side
   * against the session and `addressed` keys on the driver, so a driver per page
   * would re-drive the widget every page against the most WAF-sensitive site here.
   *
   * The streaming half used to be impossible to have alongside it. `withDriver`
   * returns `Promise<T>`, so nothing could `yield` from inside the lease — this
   * method collected every page into an array and yielded afterwards. That looked
   * like a style difference from eBay/Etsy and was a data-loss bug: `persist()`
   * runs as records are yielded, so a run blocked on page 2 threw the lease's
   * callback, discarded page 1's ~48 parsed records with the stack, and reported
   * `itemsFound: 0` — a silent hole in that day's price series wearing a BLOCKED
   * status that reads like a sufficient explanation.
   *
   * `withDriverIterable` keeps the session and restores the streaming.
   */
  async *search(ctx: CrawlContext): AsyncIterable<ProductRecord> {
    const query = ctx.query;

    if (!query) {
      throw new Error('Amazon search requires a query');
    }

    yield* this.drivers.withDriverIterable(
      (driver) => this.searchIn(driver, query, ctx),
      ctx.signal,
    );
  }

  /** The page loop, given a browser. Yields each record as it is parsed. */
  private async *searchIn(
    driver: WebDriver,
    query: string,
    ctx: CrawlContext,
  ): AsyncIterable<ProductRecord> {
    let emitted = 0;

    for (let page = 1; page <= ctx.maxPages; page++) {
      if (ctx.signal.aborted || emitted >= ctx.maxItems) return;

      const url = `${this.origin}/s?k=${encodeURIComponent(query)}&page=${page}`;

      await this.navigate(driver, url, ctx);

      // AFTER the page is loaded, not before: the widget we need lives in this
      // page's own nav bar. Once per browser, so only page 1 pays for it, and it
      // reloads this url so the cards below are priced for the new address.
      await this.ensureDeliveryAddress(driver, ctx, url);

      const pageRecords = await this.parseSearchPage(
        driver,
        `Amazon page ${page}`,
      );

      if (pageRecords.length === 0) return;

      for (const record of pageRecords) {
        if (emitted >= ctx.maxItems) return;
        yield record;
        emitted++;
      }
    }
  }

  /**
   * Parse whatever search page the driver currently has open.
   * Split out from search() so tests can point a driver at a captured HTML
   * fixture and exercise the real parser offline.
   */
  protected async parseSearchPage(
    driver: WebDriver,
    context = 'Amazon',
  ): Promise<ProductRecord[]> {
    const rendered = await this.waitForAny(driver, this.sel.resultItem);
    if (!rendered) {
      // Throws BlockedError if this is a wall rather than a genuinely empty
      // result set. Returning [] here unconditionally is what let an Etsy
      // JS challenge report SUCCEEDED / 0 items.
      await this.diagnoseEmptyPage(driver, context);
      return [];
    }

    const elements = await driver.findElements(
      By.css(this.sel.resultItem.join(', ')),
    );
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
      // attrOf, not textOf: the count lives in the link's aria-label ("1,648
      // ratings"), and the link's visible text is styled markup we'd have to
      // reassemble. See sel.reviews.
      reviewCount: parseReviewCount(
        await this.attrOf(el, this.sel.reviews, 'aria-label'),
      ),
      brand:
        cleanText((await this.textOf(el, this.sel.brand)) ?? '', 191) ||
        undefined,
      raw: { priceText },
    };
  }

  async fetchProduct(
    url: string,
    ctx: CrawlContext,
  ): Promise<ProductRecord | null> {
    const asin = this.extractAsin(url);
    if (!asin) throw new Error(`Could not extract ASIN from ${url}`);

    return this.drivers.withDriver(async (driver) => {
      await this.navigate(driver, url, ctx);
      // Detail pages hide the price for the same reason search cards do, and carry
      // the same nav widget — so set the address here, then reload for the price.
      await this.ensureDeliveryAddress(driver, ctx, url);

      const rendered = await this.waitForAny(driver, [
        '#productTitle',
        '#dp-container',
      ]);
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

      const availability = await this.textOf(body, [
        '#availability span',
        '#availability',
      ]);

      return {
        externalId: asin,
        url: `${this.origin}/dp/${asin}`,
        title: cleanText(title),
        price,
        currency: normalizeCurrency(currency),
        inStock:
          price !== null &&
          !/currently unavailable|out of stock/i.test(availability ?? ''),
        imageUrl: await this.attrOf(
          body,
          ['#landingImage', '#imgBlkFront'],
          'src',
        ),
        rating: parseRating(
          await this.textOf(body, [
            '#acrPopover .a-icon-alt',
            'span.a-icon-alt',
          ]),
        ),
        reviewCount: parseReviewCount(
          await this.textOf(body, ['#acrCustomerReviewText']),
        ),
        brand:
          cleanText((await this.textOf(body, ['#bylineInfo'])) ?? '', 191) ||
          undefined,
        seller:
          cleanText(
            (await this.textOf(body, ['#sellerProfileTriggerId'])) ?? '',
            191,
          ) || undefined,
        raw: { priceText, availability },
      };
    });
  }

  private extractAsin(url: string): string | null {
    return (
      /\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i
        .exec(url)?.[1]
        ?.toUpperCase() ?? null
    );
  }
}
