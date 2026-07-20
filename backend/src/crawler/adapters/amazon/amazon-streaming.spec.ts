import type { WebDriver } from 'selenium-webdriver';
import type { CrawlContext, ProductRecord } from '../adapter.interface';
import type { WebDriverFactory } from '../../driver/webdriver.factory';
import { BlockDetectorService } from '../../politeness/block-detector.service';
import type { RobotsService } from '../../politeness/robots.service';
import { ThrottleService } from '../../politeness/throttle.service';
import { AmazonSeleniumAdapter } from './amazon-selenium.adapter';

/**
 * Amazon must stream, like eBay and Etsy already do.
 *
 * It did not, and the reason was structural rather than a style choice. Amazon
 * needs ONE browser for the whole run — the delivery address is server-side session
 * state and `addressed` keys on the driver — but `withDriver` returns `Promise<T>`,
 * so nothing could `yield` from inside the lease. The only shape that compiled was
 * collect-everything-then-yield.
 *
 * The cost was silent data loss. `CrawlRunnerService.persist()` runs as records are
 * yielded, so a run blocked on page 2 threw out of the lease callback, discarded
 * page 1's ~48 already-parsed records with the stack, and reported `itemsFound: 0`
 * — because `stats.found` only increments inside persist(). A hole in that day's
 * price series, wearing a BLOCKED status that reads like a sufficient explanation.
 *
 * `withDriverIterable` keeps the single session AND restores the streaming, so this
 * spec pins both halves at once.
 */
describe('AmazonSeleniumAdapter — streaming', () => {
  const PAGE =
    '<html><head><title>Amazon.com : keyboard</title></head><body>' +
    '<div data-asin="B0DEMO0001" data-component-type="s-search-result">a card</div>' +
    '</body></html>';

  /** Fails the Nth `driver.get`, modelling a block landing mid-crawl. */
  function makeDriver(failOnLoad: number) {
    let loads = 0;
    let leases = 0;

    const element = {
      getText: () => Promise.resolve('A keyboard'),
      getAttribute: (attr: string) =>
        Promise.resolve(attr === 'data-asin' ? 'B0DEMO0001' : ''),
      findElement: () => elementPromise,
      findElements: () => Promise.resolve([]),
      click: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      sendKeys: () => Promise.resolve(),
    };
    const elementPromise = {
      ...element,
      then: (r: (e: typeof element) => void) => r(element),
    };

    const driver = {
      get: () => {
        loads++;
        if (loads === failOnLoad) {
          return Promise.reject(new Error('network down on page 2'));
        }
        return Promise.resolve();
      },
      getPageSource: () => Promise.resolve(PAGE),
      getTitle: () => Promise.resolve('Amazon.com : keyboard'),
      getCurrentUrl: () =>
        Promise.resolve('https://www.amazon.com/s?k=keyboard'),
      findElements: (by: { value?: string }) =>
        Promise.resolve(
          /s-search-result|data-asin/.test(by.value ?? '') ? [element] : [],
        ),
      findElement: () => elementPromise,
      wait: () => Promise.resolve(element),
      sleep: () => Promise.resolve(),
    } as unknown as WebDriver;

    return {
      driver,
      loads: () => loads,
      leases: () => leases,
      lease: () => leases++,
    };
  }

  function makeAdapter(d: ReturnType<typeof makeDriver>) {
    const config = {
      get: (key: string, fallback?: unknown) =>
        ({
          // Empty ZIP: the address flow is covered by its own spec, and leaving it
          // out keeps this one about streaming.
          AMAZON_DELIVERY_ZIP: '',
          CRAWL_MIN_DELAY_MS: 1,
          CRAWL_MAX_BACKOFF_MS: 1000,
        })[key] ?? fallback,
    } as never;

    const adapter = new AmazonSeleniumAdapter();
    Object.assign(adapter, {
      config,
      drivers: {
        withDriverIterable: <T>(fn: (drv: WebDriver) => AsyncIterable<T>) => {
          d.lease();
          return fn(d.driver);
        },
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
      query: 'keyboard',
      maxPages,
      maxItems: 1000,
      signal: new AbortController().signal,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    };
  }

  /**
   * THE BUG THIS FIXES. Page 2's load throws; page 1's record must already be in
   * the consumer's hands. Buffered, the consumer gets nothing and the run reports
   * zero found while ~48 real observations are dropped on the floor.
   */
  it('keeps page 1 when page 2 is blocked', async () => {
    const d = makeDriver(2);
    const adapter = makeAdapter(d);

    const received: ProductRecord[] = [];
    await expect(
      (async () => {
        for await (const record of adapter.search(ctx(3)))
          received.push(record);
      })(),
    ).rejects.toThrow();

    expect(received.length).toBeGreaterThan(0);
    expect(received[0].externalId).toBe('B0DEMO0001');
  });

  /** Each page is handed over as it is parsed, not all at the end. */
  it('yields page 1 before page 2 is fetched', async () => {
    const d = makeDriver(0);
    const adapter = makeAdapter(d);

    let loadsAtFirstRecord = -1;
    for await (const record of adapter.search(ctx(3))) {
      void record;
      if (loadsAtFirstRecord < 0) loadsAtFirstRecord = d.loads();
      break;
    }

    // 1 = the record surfaced after page 1 and before page 2 was requested.
    // Buffering would make this maxPages.
    expect(loadsAtFirstRecord).toBe(1);
  });

  /**
   * The half that must NOT regress while fixing the other half: Amazon's session is
   * load-bearing. One lease for the whole run, because the delivery address lives
   * server-side against it and `addressed` keys on the driver object — a browser per
   * page would re-drive the location widget on every page of every keyword.
   */
  it('uses exactly one browser for all pages', async () => {
    const d = makeDriver(0);
    const adapter = makeAdapter(d);

    for await (const record of adapter.search(ctx(3))) void record;

    expect(d.leases()).toBe(1);
    expect(d.loads()).toBeGreaterThan(1); // it really did visit several pages
  });
});
