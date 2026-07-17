import type { WebDriver } from 'selenium-webdriver';
import { BlockDetectorService } from '../../politeness/block-detector.service';
import { RobotsService } from '../../politeness/robots.service';
import { ThrottleService } from '../../politeness/throttle.service';
import type { WebDriverFactory } from '../../driver/webdriver.factory';
import type { CrawlContext } from '../adapter.interface';
import { AmazonSeleniumAdapter } from './amazon-selenium.adapter';

/**
 * Setting the delivery address before crawling.
 *
 * Amazon hides the price on listings it can't ship to the session's address, so a
 * crawl without one collects title-and-reviews rows with price: null. Naming a US
 * ZIP is the fix, and it is the delivery half of the US-market requirement that
 * i18n-prefs=USD only covers the currency half of.
 *
 * The tests that matter here are the negative ones. This flow costs an extra page
 * load and drives a widget by selector, so the failure modes worth pinning are:
 * doing it when unconfigured, doing it once per PAGE instead of once per browser,
 * failing a whole run because a popover moved, and — the subtle one — setting the
 * address AFTER loading the page it was supposed to affect.
 */

const SEARCH_PAGE = `<html><head><title>Amazon.com : keyboard</title></head><body>
  <div id="glow-ingress-line2">Holtsville 00501</div></body></html>`;

/**
 * Must clear EMPTY_BODY_THRESHOLD (50 chars). A real "no results" page still
 * carries nav and footer; a short one trips diagnoseEmptyPage's JS-challenge
 * branch and every test here fails as BLOCKED for the wrong reason.
 */
const BODY_TEXT =
  'Skip to main content Deliver to Holtsville 00501 All Departments ' +
  'No results for keyboard. Try checking your spelling. Back to top ' +
  'Conditions of Use Privacy Notice';

describe('AmazonSeleniumAdapter — delivery address', () => {
  /** Enough WebDriver surface for the widget flow; records every navigation. */
  function makeDriver(opts: { widget?: boolean; label?: string } = {}) {
    const widget = opts.widget ?? true;
    const loads: string[] = [];
    let typed = '';

    const label = opts.label ?? 'Holtsville 00501';

    const element = (text: string) => ({
      click: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      sendKeys: (v: string) => {
        typed = v;
        return Promise.resolve();
      },
      getText: () => Promise.resolve(text),
      getAttribute: () => Promise.resolve(text),
      // textOf(body, ...) reaches through the body element for the label.
      findElement: () => elementPromise(label),
    });

    /**
     * Selenium's findElement returns a WebElementPromise: awaitable AND directly
     * chainable, so both `await driver.findElement(x)` and
     * `driver.findElement(x).getText()` work. A plain Promise models only the first
     * and breaks diagnoseEmptyPage, which uses the second.
     */
    const elementPromise = (text: string) => {
      const el = element(text);
      return { ...el, then: (resolve: (e: typeof el) => void) => resolve(el) };
    };

    const driver = {
      get: (url: string) => {
        loads.push(url);
        return Promise.resolve();
      },
      getPageSource: () => Promise.resolve(SEARCH_PAGE),
      getTitle: () => Promise.resolve('Amazon.com : keyboard'),
      getCurrentUrl: () => Promise.resolve(loads[loads.length - 1] ?? ''),
      // The nav-bar widget is present iff `widget`; result containers never are,
      // so search() reads zero cards and stops after page 1.
      findElements: (by: { value?: string }) =>
        Promise.resolve(
          widget && /GLUX|glow|nav-global/.test(by.value ?? '')
            ? [element('')]
            : [],
        ),
      // The <body> scope. Its own findElement yields the location label, which is
      // how textOf(body, locationLabel) reads the address back.
      findElement: () => elementPromise(BODY_TEXT),
      wait: () =>
        widget
          ? Promise.resolve(element(''))
          : Promise.reject(new Error('no such element')),
      sleep: () => Promise.resolve(),
    } as unknown as WebDriver;

    return { driver, loads, typed: () => typed };
  }

  function makeAdapter(zip: string, driver: WebDriver) {
    const config = {
      get: (key: string, fallback?: unknown) =>
        ({
          AMAZON_DELIVERY_ZIP: zip,
          CRAWL_MIN_DELAY_MS: 1,
          CRAWL_MAX_BACKOFF_MS: 1000,
        })[key] ?? fallback,
    } as never;

    const adapter = new AmazonSeleniumAdapter();

    // Property injection — what crawler.module wires at runtime. The `!` on these
    // properties means the compiler cannot catch a missing one here.
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
    });

    return adapter;
  }

  function ctx(maxPages = 1): CrawlContext {
    return {
      query: 'keyboard',
      maxPages,
      maxItems: 10,
      signal: new AbortController().signal,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    };
  }

  async function drain(
    adapter: AmazonSeleniumAdapter,
    c: CrawlContext,
  ): Promise<void> {
    for await (const record of adapter.search(c)) {
      // Parsing isn't under test; this spec asserts navigation, not records.
      void record;
    }
  }

  /** Unconfigured must mean untouched — no extra request, no widget, no risk. */
  it('does nothing at all when no ZIP is configured', async () => {
    const { driver, loads } = makeDriver();
    await drain(makeAdapter('', driver), ctx());

    expect(loads).toEqual(['https://www.amazon.com/s?k=keyboard&page=1']);
  });

  /**
   * THE ORDERING TEST. An address set after the search page loads does nothing for
   * that page — Amazon priced it against the old (IP-inferred) location. Setting it
   * "successfully" and still collecting price-less rows is the failure this catches.
   */
  it('sets the address BEFORE loading the first search page', async () => {
    const { driver, loads, typed } = makeDriver();
    await drain(makeAdapter('00501', driver), ctx());

    expect(loads[0]).toBe('https://www.amazon.com/');
    expect(loads[1]).toBe('https://www.amazon.com/s?k=keyboard&page=1');
    expect(typed()).toBe('00501');
  });

  /**
   * The address lives in the browser session, so a browser that already has one
   * must not be sent to the homepage again. In production every crawl gets a fresh
   * driver; here both crawls share one, which is what makes the WeakSet observable.
   */
  it('sets the address once per browser, however many crawls share it', async () => {
    const { driver, loads } = makeDriver();
    const adapter = makeAdapter('00501', driver);

    await drain(adapter, ctx());
    await drain(adapter, ctx());

    expect(loads.filter((u) => u === 'https://www.amazon.com/')).toHaveLength(
      1,
    );
  });

  /**
   * Best-effort: a moved popover costs prices on non-shippable items, which is the
   * status quo. Failing the run instead would turn a partial-data problem into a
   * no-data problem.
   */
  it('carries on with the crawl when the widget is missing', async () => {
    const { driver, loads } = makeDriver({ widget: false });

    await expect(
      drain(makeAdapter('00501', driver), ctx()),
    ).resolves.toBeUndefined();
    expect(loads).toContain('https://www.amazon.com/s?k=keyboard&page=1');
  });

  /**
   * Marked as attempted BEFORE the attempt, so a failure doesn't re-arm. Retrying a
   * failed widget on every subsequent crawl would multiply requests against a site
   * that may already be refusing us — which is how a soft block becomes a hard one.
   */
  it('does not re-attempt the address after it fails once', async () => {
    const { driver, loads } = makeDriver({ widget: false });
    const adapter = makeAdapter('00501', driver);

    await drain(adapter, ctx());
    await drain(adapter, ctx());

    expect(loads.filter((u) => u === 'https://www.amazon.com/')).toHaveLength(
      1,
    );
  });
});
