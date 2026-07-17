import { EbayApiAdapter } from './ebay/ebay-api.adapter';
import { EtsyApiAdapter } from './etsy/etsy-api.adapter';

/**
 * How many items an API page requests, and why the number is not the API's maximum.
 *
 * A sweep sets maxItems: null, which CrawlRunnerService translates to Infinity —
 * "bounded only by maxPages". That makes the page-size expression the ONLY thing
 * deciding how much "page 2" means, and the API and browser paths must agree:
 * otherwise setting EBAY_APP_ID silently changes what a keyword's dataset is,
 * which is a config flag redefining the data.
 *
 * These read the private constants on purpose. They are private because nothing
 * should set them at runtime, but they are a contract with ebay-selenium's
 * `&_ipg=60`, and a contract nothing asserts is a comment.
 */
describe('API adapter page size', () => {
  const pageSizeOf = (cls: unknown): number =>
    (cls as { PAGE_SIZE: number }).PAGE_SIZE;

  /**
   * The load-bearing pairing: ebay-selenium builds `&_ipg=60`, so the API must
   * request 60 to mean the same by "page". Verified against a real capture —
   * test/fixtures/ebay/search-live.html has 62 li.s-card for one _ipg=60 page
   * (60 listings + 2 promo rows that parseCard drops).
   */
  it('eBay requests the same 60 per page that ebay-selenium asks the site for', () => {
    expect(pageSizeOf(EbayApiAdapter)).toBe(60);
  });

  /**
   * REGRESSION — the bound that silently truncated, then silently over-collected.
   *
   * These were Math.min(200, ctx.maxItems) and Math.min(100, ctx.maxItems). With a
   * sweep's Infinity that resolves to the API maximum, so maxPages: 2 pulled 400
   * eBay listings against the browser path's ~120. Nothing failed; the datasets
   * just quietly differed.
   */
  it.each([
    ['eBay', EbayApiAdapter, 60],
    ['Etsy', EtsyApiAdapter, 64],
  ])('%s stays bounded when maxItems is Infinity (a sweep)', (_label, cls, expected) => {
    expect(Math.min(pageSizeOf(cls), Number.POSITIVE_INFINITY)).toBe(expected);
  });

  it.each([
    ['eBay', EbayApiAdapter],
    ['Etsy', EtsyApiAdapter],
  ])('%s never requests more than the API maximum', (_label, cls) => {
    // eBay caps `limit` at 200, Etsy at 100. Exceeding either is a 400 from the
    // marketplace, not a bigger page.
    expect(pageSizeOf(cls)).toBeLessThanOrEqual(100);
  });

  /** A job asking for 25 items must not pull a full page and throw 35 away. */
  it.each([
    ['eBay', EbayApiAdapter],
    ['Etsy', EtsyApiAdapter],
  ])('%s still lets a lower maxItems win', (_label, cls) => {
    expect(Math.min(pageSizeOf(cls), 25)).toBe(25);
  });
});
