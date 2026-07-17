import { join } from 'node:path';
import { By, type WebDriver } from 'selenium-webdriver';
import { EbaySeleniumAdapter } from '../../src/crawler/adapters/ebay/ebay-selenium.adapter';
import type { ProductRecord } from '../../src/crawler/adapters/adapter.interface';
import { FixtureServer } from '../fixtures/fixture-server';
import { createTestDriver } from '../fixtures/test-driver';

/**
 * REAL eBay markup, frozen. The offline half of what test:canary does live.
 *
 * search-live.html is a genuine capture of
 *   https://www.ebay.com/sch/i.html?_nkw=vintage+film+camera&_ipg=60
 * taken from a logged-out browser on this project's egress (Vietnam), because
 * live eBay is currently serving its soft-block error page to our headless Chrome
 * and the canary therefore cannot run at all.
 *
 * Why this file exists separately from ebay-selenium.adapter.spec.ts: that one
 * uses hand-authored markup, so its selectors and its HTML were written together
 * and agree by construction. It was fully green while every `s-item__*` selector
 * it exercises was already extinct on real eBay. Synthetic fixtures prove the
 * parser; only real markup proves the ASSUMPTIONS the parser encodes.
 *
 * This is a snapshot and it will rot — that is expected and fine. It is a floor
 * (we know we matched reality on this date), not a substitute for the canary.
 */
class TestableEbayAdapter extends EbaySeleniumAdapter {
  parse(driver: WebDriver): Promise<ProductRecord[]> {
    return this.parseSearchPage(driver);
  }
}

describe('EbaySeleniumAdapter — real eBay markup (captured 2026-07-17)', () => {
  let server: FixtureServer;
  let driver: WebDriver;
  let records: ProductRecord[];

  beforeAll(async () => {
    server = new FixtureServer(join(__dirname, '..', 'fixtures'));
    await server.start();
    driver = await createTestDriver({ offline: true });

    await driver.get(server.url('ebay/search-live.html'));
    records = await new TestableEbayAdapter().parse(driver);
  }, 90_000);

  afterAll(async () => {
    await driver?.quit();
    await server?.stop();
  });

  it('extracts products from the layout eBay actually serves', () => {
    // The whole point: if this hits 0, our selector set no longer matches eBay
    // and every crawl is silently reporting SUCCEEDED / 0 items.
    expect(records.length).toBeGreaterThan(20);
  });

  /**
   * DRIFT RECORD — `s-item__*` is extinct.
   *
   * eBay migrated the search results to `s-card__*`. Every `s-item` selector in
   * the adapter now matches zero elements on a real page; the crawl only still
   * works because sel.* are LISTS and the s-card entries catch it. The adapter's
   * own comment called this shot ("eBay A/B-tests its markup constantly... first
   * match wins, so a layout change degrades one field instead of killing the
   * run") — this asserts that safety net is load-bearing rather than decorative,
   * so nobody "simplifies" the lists down to one selector.
   */
  it('proves the fallback selectors are load-bearing: s-item is gone, s-card is live', async () => {
    const sItem = await driver.findElements(By.css('li.s-item'));
    const sCard = await driver.findElements(By.css('li.s-card'));

    expect(sItem).toHaveLength(0);
    expect(sCard.length).toBeGreaterThan(20);
  });

  /**
   * THE US-MARKET FINDING.
   *
   * eBay geolocates currency by IP exactly as Amazon does. This page carries
   * eBay's own header saying so:
   *
   *   x-ebay-c-cultural-pref: currency=VND, timezone=America%2FLos_Angeles
   *
   * and renders prices as `3,281,750.00 VND`. So ebay-selenium does NOT return
   * US-market data from this egress, and the requirement's "thị trường US" is
   * reachable on eBay only via ebay-api's X-EBAY-C-MARKETPLACE-ID: EBAY_US pin,
   * which is server-side and IP-independent.
   *
   * The assertion is "never laundered", not "is VND": a future recapture from a
   * US host should keep passing. What must never happen is a VND magnitude
   * wearing a USD label — see normalizeCurrency.
   */
  it('reports eBay\'s IP-localized currency truthfully, never as a guessed USD', () => {
    const priced = records.filter((r) => r.price !== null);
    expect(priced.length).toBeGreaterThan(0);

    for (const r of priced) {
      expect(r.currency).not.toBeNull();
      expect(r.currency).toMatch(/^[A-Z]{3}$/);
    }

    const vnd = priced.filter((r) => r.currency === 'VND');
    if (vnd.length > 0) {
      // A camera is not ₫3.28. If the grouping logic broke, these collapse.
      for (const r of vnd) expect(r.price!).toBeGreaterThan(1000);
    }
  });

  /**
   * Review counts are near-absent on eBay, and that is eBay, not our parser.
   *
   * Only 2 of 62 cards on this page carry `s-card__reviews-count`: eBay shows
   * product ratings solely for catalog products, and most listings are individual
   * seller items. This is the evidence behind choosing ebay-api (0% review counts,
   * guaranteed US) over ebay-selenium (~3% review counts, VND) — the field the
   * Selenium path supposedly buys you barely exists.
   *
   * Asserted as a RANGE, not a count: it is a property of eBay's inventory mix and
   * will move on recapture. Zero would mean the selector broke.
   */
  it('parses the few real review counts present, and does not invent the rest', () => {
    const counted = records.filter((r) => r.reviewCount !== undefined);

    // eBay renders these as "2 product ratings" — a count, not a rating. If
    // parseReviewCount's guard ever rejected the word "ratings", this hits 0.
    expect(counted.length).toBeGreaterThan(0);
    expect(counted.length).toBeLessThan(records.length / 2);

    for (const r of counted) {
      expect(Number.isInteger(r.reviewCount)).toBe(true);
      expect(r.reviewCount!).toBeGreaterThan(0);
    }
  });

  it('builds canonical /itm/<id> URLs from the real hrefs', () => {
    for (const r of records) {
      expect(r.externalId).toMatch(/^\d{9,15}$/);
      expect(r.url).toContain('/itm/');
      expect(r.url).not.toMatch(/_trkparms|hash=item/);
    }
  });

  /**
   * REGRESSION — eBay was collecting zero images, and nothing noticed.
   *
   * All three image selectors were dead at once: the two `s-item__*` entries went
   * extinct with the layout, and `.s-card__image img` was simply wrong —
   * s-card__image is the class ON the <img>, so it searched for an <img> inside an
   * <img>. imageUrl is optional on ProductRecord, so the type system couldn't
   * care, and the synthetic fixture defined its own markup, so it agreed.
   *
   * Image is one of the four required fields. Asserted as a MAJORITY, not `some`:
   * a single lucky match would have hidden exactly this bug.
   */
  it('collects images for the large majority of real listings', () => {
    const withImage = records.filter((r) => r.imageUrl !== undefined);
    expect(withImage.length).toBeGreaterThan(records.length * 0.8);

    for (const r of withImage) {
      expect(r.imageUrl).toMatch(/^https:\/\/i\.ebayimg\.com\//);
    }
  });

  it('populates a title for every listing it keeps', () => {
    for (const r of records) {
      expect(r.title.length).toBeGreaterThan(0);
    }
  });
});
