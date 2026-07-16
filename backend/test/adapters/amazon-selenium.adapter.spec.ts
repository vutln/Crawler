import { join } from 'node:path';
import type { WebDriver } from 'selenium-webdriver';
import { AmazonSeleniumAdapter } from '../../src/crawler/adapters/amazon/amazon-selenium.adapter';
import type { ProductRecord } from '../../src/crawler/adapters/adapter.interface';
import { FixtureServer } from '../fixtures/fixture-server';
import { createTestDriver } from '../fixtures/test-driver';

/**
 * Unlike the eBay spec, this one runs against REAL captured Amazon markup
 * (test/fixtures/amazon/search.html, via `npm run fixtures:capture`). That makes
 * these assertions meaningful about production Amazon, not just about our parser
 * in isolation.
 *
 * It exists because a live crawl "succeeded" while storing null for every single
 * price — the worst possible failure for a price collector, because the run looks
 * green. Two real bugs caused it, both now pinned here:
 *   1. price/rating live in visually-hidden nodes, so getText() returns ""
 *   2. the captured page serves VND (Amazon geolocates), whose "3,674,457"
 *      thousands-grouping was misread as a decimal separator
 */
class TestableAmazonAdapter extends AmazonSeleniumAdapter {
  parse(driver: WebDriver): Promise<ProductRecord[]> {
    return this.parseSearchPage(driver);
  }
}

describe('AmazonSeleniumAdapter — real captured fixture', () => {
  let server: FixtureServer;
  let driver: WebDriver;
  let records: ProductRecord[];

  beforeAll(async () => {
    server = new FixtureServer(join(__dirname, '..', 'fixtures'));
    await server.start();

    // offline: the captured Amazon page still references its CDN. Without this
    // the test silently hits the network and hangs on slow hosts — the exact
    // flakiness fixtures are supposed to eliminate.
    driver = await createTestDriver({ offline: true });

    await driver.get(server.url('amazon/search.html'));
    records = await new TestableAmazonAdapter().parse(driver);
  }, 120_000);

  afterAll(async () => {
    await driver?.quit();
    await server?.stop();
  });

  it('extracts products from the search grid', () => {
    expect(records.length).toBeGreaterThan(0);
  });

  it('reads a valid ASIN for every product', () => {
    for (const r of records) {
      expect(r.externalId).toMatch(/^[A-Z0-9]{10}$/);
    }
  });

  it('reads a non-empty title for every product', () => {
    for (const r of records) {
      expect(r.title.length).toBeGreaterThan(0);
    }
  });

  /**
   * THE REGRESSION TEST. Amazon renders the price inside `.a-price .a-offscreen`,
   * which is clipped to a 0x0 rect for screen readers. Selenium's getText()
   * returns "" for it, so without the textContent fallback every price is null
   * and the collector silently collects no prices.
   */
  it('extracts a price for most products (guards the a-offscreen trap)', () => {
    const priced = records.filter((r) => r.price !== null);
    // Not all: sponsored tiles and "see options" listings genuinely have no price.
    expect(priced.length).toBeGreaterThan(records.length / 2);
  });

  it('never parses a price as zero or negative', () => {
    for (const r of records.filter((r) => r.price !== null)) {
      expect(r.price!).toBeGreaterThan(0);
    }
  });

  /**
   * Guards the thousands-separator bug. This fixture was captured from a
   * Vietnam IP, so Amazon served VND: "VND 3,674,457". Misreading the final
   * comma as a decimal point yields 3.674 — a 1,000,000x error that looks
   * entirely plausible in a table.
   */
  it('parses grouped thousands without collapsing them into decimals', () => {
    const priced = records.filter((r) => r.price !== null);
    const currencies = new Set(priced.map((r) => r.currency));

    if (currencies.has('VND')) {
      const vnd = priced.filter((r) => r.currency === 'VND');
      // A real keyboard is never 3.67 dong (~$0.00015). Anything under 1000 VND
      // means the separator logic broke.
      for (const r of vnd) {
        expect(r.price!).toBeGreaterThan(1000);
      }
    } else {
      // USD fixture: a mechanical keyboard is not $0.02.
      for (const r of priced) {
        expect(r.price!).toBeGreaterThan(1);
      }
    }
  });

  it('extracts a rating for at least one product (a-icon-alt is hidden too)', () => {
    expect(records.some((r) => r.rating !== undefined)).toBe(true);
  });

  it('builds a canonical /dp/<asin> URL free of tracking params', () => {
    for (const r of records) {
      expect(r.url).toContain(r.externalId);
      expect(r.url).not.toMatch(/[?&]ref=|[?&]qid=/);
    }
  });
});
