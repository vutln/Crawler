import type { WebDriver } from 'selenium-webdriver';
import type { CrawlContext, ProductRecord } from '../adapter.interface';
import type { WebDriverFactory } from '../../driver/webdriver.factory';
import { BlockDetectorService } from '../../politeness/block-detector.service';
import type { RobotsService } from '../../politeness/robots.service';
import { ThrottleService } from '../../politeness/throttle.service';
import { EbaySeleniumAdapter } from './ebay-selenium.adapter';

/**
 * STREAMING BASELINE — records must reach the pipeline BEFORE the next page loads.
 *
 * This encodes behaviour eBay has today so that a refactor cannot quietly remove
 * it. `search()` is an `AsyncIterable`, and eBay genuinely streams: `yield` happens
 * inside the page loop, so `CrawlRunnerService.persist()` has already written
 * page 1's rows by the time page 2 is requested.
 *
 * The thing that makes this fragile: `WebDriverFactory.withDriver(fn)` takes a
 * callback returning `Promise<T>`, so you cannot `yield` from inside it. Any change
 * that hoists the driver lease to cover the whole run — which is what a single
 * browser session requires — is pushed by the type system straight into Amazon's
 * shape: collect everything, return an array, yield afterwards.
 *
 * The cost of that is not theoretical. A 2-page crawl blocked on page 2 today keeps
 * page 1's ~60 rows; buffered, they are discarded with the stack and the run reports
 * `itemsFound: 0`, because `stats.found` only increments inside `persist()`. For a
 * price SERIES that means a silent hole in the day's data, wearing a BLOCKED status
 * that looks like a sufficient explanation.
 */
describe('EbaySeleniumAdapter — streaming baseline', () => {
  const CARD =
    '<li class="s-card"><a href="/itm/285000000001">A thing</a></li>';
  const PAGE = `<html><head><title>eBay</title></head><body>${CARD}</body></html>`;

  /**
   * Fails the Nth `driver.get`. Models a block landing mid-crawl, which is the
   * only situation where buffering vs streaming is observable from outside.
   */
  function makeDrivers(failOnLoad: number) {
    let loads = 0;

    const element = {
      getText: () => Promise.resolve('A thing'),
      getAttribute: (attr: string) =>
        Promise.resolve(
          attr === 'href' ? 'https://www.ebay.com/itm/285000000001' : '',
        ),
      findElement: () => Promise.resolve(element),
      findElements: () => Promise.resolve([]),
    };
    const elementPromise = {
      ...element,
      then: (r: (e: typeof element) => void) => r(element),
    };

    const driver = {
      get: () => {
        loads++;
        if (loads === failOnLoad)
          return Promise.reject(new Error('network down'));
        return Promise.resolve();
      },
      getPageSource: () => Promise.resolve(PAGE),
      getTitle: () => Promise.resolve('eBay'),
      getCurrentUrl: () => Promise.resolve('https://www.ebay.com/sch/i.html'),
      findElements: (by: { value?: string }) =>
        Promise.resolve(/s-card|s-item/.test(by.value ?? '') ? [element] : []),
      findElement: () => elementPromise,
      wait: () => Promise.resolve(element),
      sleep: () => Promise.resolve(),
    } as unknown as WebDriver;

    return { driver, loads: () => loads };
  }

  function makeAdapter(driver: WebDriver) {
    const config = {
      get: (key: string, fallback?: unknown) =>
        ({ CRAWL_MIN_DELAY_MS: 1, CRAWL_MAX_BACKOFF_MS: 1000 })[key] ??
        fallback,
    } as never;

    const adapter = new EbaySeleniumAdapter();
    Object.assign(adapter, {
      config,
      drivers: {
        withDriver: <T>(fn: (d: WebDriver) => Promise<T>) => fn(driver),
      } as unknown as WebDriverFactory,
      robots: {
        isAllowed: () => Promise.resolve(true),
        crawlDelayMs: () => Promise.resolve(null),
      } as unknown as RobotsService,
      throttle: new ThrottleService(config),
      blockDetector: new BlockDetectorService(),
      logger: {
        log: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        verbose: () => {},
      },
    });
    return adapter;
  }

  function ctx(maxPages: number): CrawlContext {
    return {
      query: 'vintage film camera',
      maxPages,
      maxItems: 1000,
      signal: new AbortController().signal,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    };
  }

  /**
   * THE BASELINE. Page 2's load throws; page 1's record must ALREADY have been
   * handed to the consumer. Under buffering the consumer receives nothing at all.
   */
  it('yields page 1 before page 2 is fetched, so a later failure cannot discard it', async () => {
    const { driver } = makeDrivers(2); // second driver.get throws
    const adapter = makeAdapter(driver);

    const received: ProductRecord[] = [];
    await expect(
      (async () => {
        for await (const record of adapter.search(ctx(3)))
          received.push(record);
      })(),
    ).rejects.toThrow();

    expect(received.length).toBeGreaterThan(0);
    expect(received[0].externalId).toBe('285000000001');
  });

  /**
   * The same property stated as an ordering rather than a survival claim: the
   * consumer must be able to observe a record while the crawl is still running.
   */
  it('hands over each page as it is parsed, not all at the end', async () => {
    const { driver, loads } = makeDrivers(0); // never fails
    const adapter = makeAdapter(driver);

    let loadsWhenFirstRecordArrived = -1;
    for await (const _record of adapter.search(ctx(3))) {
      void _record;
      if (loadsWhenFirstRecordArrived < 0)
        loadsWhenFirstRecordArrived = loads();
      break; // stop early — the consumer is allowed to walk away
    }

    // 1 means the first record surfaced after page 1 and before page 2 was asked
    // for. Buffering would make this equal maxPages.
    expect(loadsWhenFirstRecordArrived).toBe(1);
  });
});
