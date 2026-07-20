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
const HOME_URL = 'https://www.amazon.com/';
const SEARCH_URL = 'https://www.amazon.com/s?k=keyboard&page=1';

const BODY_TEXT =
  'Skip to main content Deliver to Holtsville 00501 All Departments ' +
  'No results for keyboard. Try checking your spelling. Back to top ' +
  'Conditions of Use Privacy Notice';

describe('AmazonSeleniumAdapter — delivery address', () => {
  /**
   * Enough WebDriver surface for the widget flow; records every navigation.
   *
   * `rendersLate` — findElements finds nothing until something has WAITED for the
   * nav. Amazon injects it with JS after document load (`nav-progressive-*`), so a
   * bare look right after driver.get() misses it. This is the option that
   * distinguishes waiting from not waiting.
   */
  function makeDriver(
    opts: { widget?: boolean; label?: string; rendersLate?: boolean } = {},
  ) {
    const hasWidget = opts.widget ?? true;
    const loads: string[] = [];
    let typed = '';
    let pageLoads = 0;
    let waited = false;

    const label = opts.label ?? 'Holtsville 00501';

    /** Is the nav present for a look happening right now? */
    const navVisible = (): boolean => {
      if (!hasWidget) return false;
      // Progressive rendering: only there once someone gave it time.
      return opts.rendersLate ? waited : true;
    };

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
        pageLoads++;
        // A fresh document: whatever the last page rendered does not carry over.
        waited = false;
        return Promise.resolve();
      },
      getPageSource: () => Promise.resolve(SEARCH_PAGE),
      getTitle: () => Promise.resolve('Amazon.com : keyboard'),
      getCurrentUrl: () => Promise.resolve(loads[loads.length - 1] ?? ''),
      // The nav-bar widget follows navVisible(); result containers never match,
      // so search() reads zero cards and stops after page 1.
      findElements: (by: { value?: string }) =>
        Promise.resolve(
          navVisible() && /GLUX|glow|nav-global/.test(by.value ?? '')
            ? [element('')]
            : [],
        ),
      // The <body> scope. Its own findElement yields the location label, which is
      // how textOf(body, locationLabel) reads the address back.
      findElement: () => elementPromise(BODY_TEXT),
      /**
       * Stands in for both waitForAny and the zip input's wait. Waiting is what
       * lets progressive rendering finish, so record that it happened — that is
       * exactly the difference between looking once and looking properly.
       */
      wait: () => {
        const wasVisible = navVisible();
        waited = true;
        // Resolves if the nav is there now, or would be once rendering settles.
        return wasVisible || navVisible()
          ? Promise.resolve(element(''))
          : Promise.reject(new Error('no such element'));
      },
      sleep: () => Promise.resolve(),
    } as unknown as WebDriver;

    const countOf = (url: string) => loads.filter((u) => u === url).length;
    const homepageLoadCount = () => countOf(HOME_URL);
    const searchLoadCount = () => countOf(SEARCH_URL);

    return {
      driver,
      loads,
      typed: () => typed,
      totalLoads: () => pageLoads,
      homepageLoadCount,
      searchLoadCount,
    };
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

    expect(loads).toEqual([SEARCH_URL]);
  });

  /**
   * THE ONE THAT COST THE MOST TIME.
   *
   * The flow used to drive the widget on https://www.amazon.com/ — the single most
   * aggressively challenged page on the site. Measured 2026-07-20, same browser,
   * alternating loads:
   *
   *   homepage     nav=0  waf=Y  len=  1,995     <- AWS WAF challenge
   *   search page  nav=1  waf=n  len=1,701,704
   *
   * So the address silently failed on exactly the runs where the crawl itself was
   * working fine: "No location widget after 15s ... Delivery address not set",
   * followed by a perfectly good 108-product run with no US prices.
   *
   * The nav is global. Never go to the homepage for it.
   */
  it('never loads the homepage — the widget is on the page we already wanted', async () => {
    const { driver, homepageLoadCount, typed } = makeDriver();
    await drain(makeAdapter('00501', driver), ctx());

    expect(homepageLoadCount()).toBe(0);
    expect(typed()).toBe('00501'); // ...and it still got set
  });

  /**
   * THE ORDERING TEST. The page in the browser when the address is applied was
   * rendered against the OLD location, so its prices are the wrong ones. Applying
   * and then parsing what is already on screen collects exactly the price-less rows
   * this feature exists to fix — the reload is not optional.
   */
  it('reloads the search page after applying, before parsing it', async () => {
    const { driver, loads, typed } = makeDriver();
    await drain(makeAdapter('00501', driver), ctx());

    expect(loads).toEqual([SEARCH_URL, SEARCH_URL]);
    expect(typed()).toBe('00501');
  });

  /**
   * The address lives in the browser session, so a browser that already has one
   * must not be sent through the flow again. In production every crawl gets a fresh
   * driver; here both crawls share one, which is what makes the WeakSet observable.
   */
  it('sets the address once per browser, however many crawls share it', async () => {
    const { driver, searchLoadCount } = makeDriver();
    const adapter = makeAdapter('00501', driver);

    await drain(adapter, ctx());
    expect(searchLoadCount()).toBe(2); // load + reload

    await drain(adapter, ctx());
    expect(searchLoadCount()).toBe(3); // second crawl: load only, no reload
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
    expect(loads).toContain(SEARCH_URL);
  });

  /**
   * Marked as attempted BEFORE the attempt, so a failure doesn't re-arm. Retrying a
   * failed widget on every subsequent crawl would multiply requests against a site
   * that may already be refusing us — which is how a soft block becomes a hard one.
   */
  it('does not re-attempt the address after it fails once', async () => {
    const { driver, searchLoadCount } = makeDriver({ widget: false });
    const adapter = makeAdapter('00501', driver);

    await drain(adapter, ctx());
    // One load, and NO reload — there was nothing to re-price.
    expect(searchLoadCount()).toBe(1);

    await drain(adapter, ctx());
    expect(searchLoadCount()).toBe(2); // second crawl: its own load, nothing extra
  });

  /**
   * THE BUG THIS FLOW SHIPPED WITH.
   *
   * Amazon injects the nav with JS — its own markup carries
   * `nav-progressive-attribute` / `nav-progressive-content` — and driver.get()
   * resolves before that runs. The gate used to be a bare findElements, so it
   * looked before the nav existed, logged "no location widget on the page", and
   * gave up for the whole crawl. Every other step in the method already waited;
   * the one gating them all did not.
   *
   * Reported as: the address only applies when the page is already good, and
   * silently does nothing whenever a reload was needed — a page served after a Dogs
   * page comes back cold and renders slower, so the race is lost far more often.
   */
  it('waits for the progressively-rendered nav instead of looking once', async () => {
    const { driver, typed } = makeDriver({ rendersLate: true });
    await drain(makeAdapter('00501', driver), ctx());

    // Reaching sendKeys at all means the gate survived the late render.
    expect(typed()).toBe('00501');
  });
});
