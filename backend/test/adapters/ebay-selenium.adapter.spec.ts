import { join } from 'node:path';
import type { WebDriver } from 'selenium-webdriver';
import { EbaySeleniumAdapter } from '../../src/crawler/adapters/ebay/ebay-selenium.adapter';
import type { ProductRecord } from '../../src/crawler/adapters/adapter.interface';
import { FixtureServer } from '../fixtures/fixture-server';
import { createTestDriver } from '../fixtures/test-driver';

/**
 * Adapter parsing tests: REAL browser, REAL parser, FROZEN html.
 *
 * The point is determinism. Pointing these at live eBay would mean tests that
 * fail on eBay's A/B tests, rate limits, and CAPTCHAs — i.e. tests that go red
 * for reasons unrelated to our code, which trains everyone to ignore red.
 *
 * Scope check: this validates parsing LOGIC (id extraction, price integration,
 * junk-row filtering) against SYNTHETIC markup. It cannot tell you the selectors
 * still match production eBay — the markup and the selectors were written
 * together, so it agrees with itself by construction.
 *
 * That blind spot was real: while this file was green, every `s-item__*` selector
 * it exercises had already gone extinct on live eBay (migrated to `s-card__*`).
 * ebay-live-dom.spec.ts pins the real markup; test:canary catches future drift.
 * This file keeps the junk rows a live capture won't reliably contain.
 */

/**
 * Exposes the protected parseSearchPage without weakening the real class's API.
 *
 * Constructing this outside Nest leaves the @Inject'd properties undefined —
 * which is fine here ONLY because parsing is pure DOM work that touches none of
 * them. Note the limit that implies: this tier cannot catch DI wiring bugs.
 * (It didn't: a real one shipped past a green suite and was caught only by a
 * live crawl.) Parsing correctness is all this proves.
 */
class TestableEbayAdapter extends EbaySeleniumAdapter {
  parse(driver: WebDriver): Promise<ProductRecord[]> {
    return this.parseSearchPage(driver);
  }
}

describe('EbaySeleniumAdapter — synthetic fixture parsing', () => {
  let server: FixtureServer;
  let driver: WebDriver;
  let records: ProductRecord[];

  beforeAll(async () => {
    server = new FixtureServer(join(__dirname, '..', 'fixtures'));
    await server.start();
    driver = await createTestDriver({ offline: true });

    await driver.get(server.url('ebay/search-synthetic.html'));
    records = await new TestableEbayAdapter().parse(driver);
  }, 90_000);

  afterAll(async () => {
    await driver?.quit();
    await server?.stop();
  });

  it('keeps only real listings and drops junk rows', () => {
    // 6 rows in the fixture; 3 are junk (promo row, linkless separator) or
    // otherwise unusable. Getting 4 here proves the filters fire.
    expect(records).toHaveLength(4);
    expect(records.map((r) => r.externalId)).toEqual([
      '285000000001',
      '285000000002',
      '285000000003',
      '285000000005',
    ]);
  });

  it('extracts the item id from both plain and slug URLs', () => {
    expect(records[0].externalId).toBe('285000000001');
    // .../itm/vintage-nikon-fm2/285000000002 — slug before the id
    expect(records[1].externalId).toBe('285000000002');
  });

  it('parses a simple USD price', () => {
    expect(records[0]).toMatchObject({
      title: 'Canon AE-1 35mm SLR Film Camera with 50mm f/1.8 Lens',
      price: 149.5,
      currency: 'USD',
      inStock: true,
    });
  });

  it('strips the "New Listing" prefix from titles', () => {
    expect(records[1].title).toBe('Nikon FM2 Body Only, Black');
    expect(records[1].title).not.toMatch(/New Listing/);
  });

  it('takes the low end of an EU-formatted range', () => {
    // €1.234,56 is 1234.56 — not 1.23456 and not 123456.
    expect(records[2]).toMatchObject({ price: 1234.56, currency: 'EUR' });
  });

  it('records an unpriced listing as null, not zero, and out of stock', () => {
    expect(records[3].price).toBeNull();
    expect(records[3].inStock).toBe(false);
  });

  it('strips tracking params from the canonical URL', () => {
    expect(records[0].url).not.toMatch(/_trkparms|hash=/);
    expect(records[0].url).toContain('/itm/285000000001');
  });

  it('extracts seller and review count', () => {
    expect(records[0].seller).toBe('retro_optics');
    expect(records[0].reviewCount).toBe(1204);
  });
});
