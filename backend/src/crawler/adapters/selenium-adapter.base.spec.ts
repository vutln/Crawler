import type { WebDriver } from 'selenium-webdriver';
import { Marketplace } from '../../generated/prisma/client';
import { BlockDetectorService } from '../politeness/block-detector.service';
import { RobotsService } from '../politeness/robots.service';
import { ThrottleService } from '../politeness/throttle.service';
import { WebDriverFactory } from '../driver/webdriver.factory';
import {
  BlockedError,
  type CrawlContext,
  type ProductRecord,
} from './adapter.interface';
import { SeleniumAdapterBase } from './selenium-adapter.base';

/**
 * navigate()'s block handling — specifically the ambiguous-reload rule.
 *
 * The retry exists because the marketplace error page is ambiguous by nature: it
 * is served both for real 5xx blips and as a soft block, and one sample cannot
 * tell them apart. The valuable tests here are the NEGATIVE ones: that an explicit
 * refusal (a CAPTCHA) is never knocked on twice, and that a persistent error page
 * still ends as BLOCKED with the full backoff. A retry that widened into a loop
 * would be the exact thing this codebase refuses to do.
 */

/** Amazon's real "Dogs of Amazon" wording. Ambiguous: could be a genuine 5xx. */
const DOGS_PAGE = `<html><head><title>Sorry! Something went wrong!</title></head><body>
  <h1>Sorry! Something went wrong on our end.</h1></body></html>`;

/** An explicit refusal, in words. Never retryable. */
const CAPTCHA_PAGE = `<html><head><title>Robot Check</title></head><body>
  <h4>Enter the characters you see below</h4></body></html>`;

const GOOD_PAGE = `<html><head><title>Amazon.com : keyboard</title></head><body>
  <div data-component-type="s-search-result">a real result</div></body></html>`;

/**
 * Distil/Imperva's holding page — a bot check that forwards you on by itself once
 * its JS check passes. Self-resolving: the right response is to WAIT, not reload.
 */
const INTERSTITIAL_PAGE = `<html><head><title>Pardon Our Interruption</title></head>
  <body><h1>Pardon Our Interruption</h1>
  <p>As you were browsing something about your browser made us think you were a bot.</p>
  </body></html>`;

/**
 * DataDome. Looks like a holding page and is NOT one — measured 2026-07-20 sitting
 * unchanged for 63s across two reloads. Must be treated as an explicit refusal.
 */
const DATADOME_PAGE = `<html><head><title>etsy.com</title></head><body>
  <script src="https://geo.captcha-delivery.com/captcha/"></script></body></html>`;

class TestAdapter extends SeleniumAdapterBase {
  readonly marketplace = Marketplace.AMAZON;
  readonly name = 'test-adapter';

  search(): AsyncIterable<ProductRecord> {
    throw new Error('not used');
  }
  fetchProduct(): Promise<ProductRecord | null> {
    throw new Error('not used');
  }
  /** navigate() is protected and is the unit under test. */
  go(driver: WebDriver, url: string, ctx: CrawlContext): Promise<void> {
    return this.navigate(driver, url, ctx);
  }
}

describe('SeleniumAdapterBase.navigate — block handling', () => {
  const URL = 'https://www.amazon.com/s?k=keyboard';

  /**
   * Serves `pages` in order, one per driver.get(). Records how many loads happened.
   *
   * `morph` models a page that changes WITHOUT a new navigation — which is exactly
   * what a self-resolving interstitial does when its JS check passes and it
   * forwards the browser. Without it there is no way to tell "we waited and the
   * page resolved" apart from "we re-fetched and got something else", and that
   * distinction is the entire point of the interstitial path.
   */
  function makeDriver(
    pages: string[],
    morph?: { becomes: string; afterMs: number },
  ): { driver: WebDriver; loads: () => number } {
    let i = 0;
    let current = '';
    let loadedAt = 0;

    const visible = (): string =>
      morph && Date.now() - loadedAt >= morph.afterMs ? morph.becomes : current;

    const driver = {
      get: (_url: string) => {
        current = pages[Math.min(i, pages.length - 1)];
        loadedAt = Date.now();
        i++;
        return Promise.resolve();
      },
      getPageSource: () => Promise.resolve(visible()),
      getTitle: () =>
        Promise.resolve(/<title>([^<]*)</.exec(visible())?.[1] ?? ''),
      getCurrentUrl: () => Promise.resolve(URL),
    } as unknown as WebDriver;
    return { driver, loads: () => i };
  }

  function makeAdapter(): { adapter: TestAdapter; throttle: ThrottleService } {
    // minDelay must be non-zero: backoff is minDelayMs * 2**steps, so a 0 floor
    // makes every backoff 0 and would quietly neuter the assertions below. 1ms
    // keeps the suite fast while leaving the arithmetic observable.
    const config = {
      get: (key: string, fallback?: unknown) =>
        ({
          CRAWL_MIN_DELAY_MS: 1,
          CRAWL_MAX_BACKOFF_MS: 1000,
          CRAWL_MAX_BLOCK_RELOADS: 2,
          // Explicit and tiny. Falling through to the real 20s default would make
          // every self-resolving case sit in real time — the suite would take
          // minutes and the failure would look like a hang, not an assertion.
          CRAWL_INTERSTITIAL_WAIT_MS: 40,
        })[key] ?? fallback,
    } as never;

    const throttle = new ThrottleService(config);
    const adapter = new TestAdapter();

    // Property injection: Nest would do this, and the properties are declared with
    // `!` so the compiler can't help us here. Mirrors what crawler.module wires.
    Object.assign(adapter, {
      // The base reads its reload/wait knobs off this; without it navigate()
      // throws on `this.config.get` before ever reaching the block logic.
      config,
      drivers: {} as WebDriverFactory,
      robots: {
        isAllowed: () => Promise.resolve(true),
        crawlDelayMs: () => Promise.resolve(null),
      } as unknown as RobotsService,
      throttle,
      blockDetector: new BlockDetectorService(),
    });

    return { adapter, throttle };
  }

  function ctx(): CrawlContext {
    return {
      signal: new AbortController().signal,
      maxPages: 1,
      maxItems: 10,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    };
  }

  it('loads a clean page once and records a success', async () => {
    const { adapter, throttle } = makeAdapter();
    const { driver, loads } = makeDriver([GOOD_PAGE]);

    await expect(adapter.go(driver, URL, ctx())).resolves.toBeUndefined();
    expect(loads()).toBe(1);
    expect(throttle.backoffMsFor(URL)).toBe(0);
  });

  /**
   * The reason the reloads exist: the error page cleared on a second look, so it
   * was a blip. Previously this cost 6 backoff steps and failed the whole run.
   *
   * Stops at 2 loads, not 3: the budget is an upper bound, not a quota. Once the
   * page renders there is nothing left to disambiguate.
   */
  it('takes a second look at the ambiguous error page and proceeds when it clears', async () => {
    const { adapter, throttle } = makeAdapter();
    const { driver, loads } = makeDriver([DOGS_PAGE, GOOD_PAGE]);

    await expect(adapter.go(driver, URL, ctx())).resolves.toBeUndefined();
    expect(loads()).toBe(2);
    // Transient, so nothing is owed: no wall was ever recorded.
    expect(throttle.backoffMsFor(URL)).toBe(0);
  });

  /** The case the second reload buys: two error pages, then a real one. */
  it('takes a third look when the error page survives the second', async () => {
    const { adapter, throttle } = makeAdapter();
    const { driver, loads } = makeDriver([DOGS_PAGE, DOGS_PAGE, GOOD_PAGE]);

    await expect(adapter.go(driver, URL, ctx())).resolves.toBeUndefined();
    expect(loads()).toBe(3);
    expect(throttle.backoffMsFor(URL)).toBe(0);
  });

  it('calls it a wall when the error page persists, and charges the full backoff', async () => {
    const { adapter, throttle } = makeAdapter();
    const { driver, loads } = makeDriver([DOGS_PAGE, DOGS_PAGE, DOGS_PAGE]);

    await expect(adapter.go(driver, URL, ctx())).rejects.toThrow(BlockedError);
    // The bound holds: 1 + MAX_AMBIGUOUS_RELOADS, never a fourth knock. makeDriver
    // serves its last page forever, so an unbounded loop would hang here rather
    // than fail — this number is the only thing pinning termination.
    expect(loads()).toBe(3);
    expect(throttle.backoffMsFor(URL)).toBeGreaterThan(0);
  });

  /**
   * Ambiguity is not persistence. If the second look comes back an EXPLICIT
   * refusal, reloading stops immediately — the remaining budget is not spent,
   * because the site has now answered in words.
   */
  it('stops reloading the moment an ambiguous page hardens into a refusal', async () => {
    const { adapter, throttle } = makeAdapter();
    const { driver, loads } = makeDriver([DOGS_PAGE, CAPTCHA_PAGE, GOOD_PAGE]);

    await expect(adapter.go(driver, URL, ctx())).rejects.toThrow(
      /blocked the request/i,
    );
    // 3 would mean we burned the last reload on a page that already said no —
    // and note the third page is GOOD, so doing so would have "succeeded".
    expect(loads()).toBe(2);
    expect(throttle.backoffMsFor(URL)).toBeGreaterThan(0);
  });

  /**
   * THE IMPORTANT ONE.
   *
   * A CAPTCHA is the site refusing us in words. Reloading it would be re-asking a
   * question that was already answered — a retry loop, and the precise behaviour
   * this project declines to implement. The reload budget must never widen to
   * cover explicit refusals, so this asserts a single load and an immediate wall.
   *
   * This matters more as the budget grows: raising MAX_AMBIGUOUS_RELOADS must
   * change how long we spend disambiguating, never what we're willing to reload.
   */
  it('never knocks twice on an explicit refusal', async () => {
    const { adapter, throttle } = makeAdapter();
    const { driver, loads } = makeDriver([CAPTCHA_PAGE, GOOD_PAGE]);

    await expect(adapter.go(driver, URL, ctx())).rejects.toThrow(
      /blocked the request/i,
    );
    // Would be 2 if the retry ever leaked past the `ambiguous` guard — and note the
    // second page is GOOD, so a leaky retry would have silently "succeeded".
    expect(loads()).toBe(1);
    expect(throttle.backoffMsFor(URL)).toBeGreaterThan(0);
  });

  it('does not retry on an aborted run', async () => {
    const { adapter } = makeAdapter();
    const { driver, loads } = makeDriver([DOGS_PAGE, GOOD_PAGE]);

    const controller = new AbortController();
    const aborted = { ...ctx(), signal: controller.signal };
    controller.abort();

    await expect(adapter.go(driver, URL, aborted)).rejects.toThrow(/abort/i);
    expect(loads()).toBe(0);
  });

  /**
   * Self-resolving interstitials: WAIT, do not reload.
   *
   * A "checking your browser" page is already telling us what it is, so the right
   * response is the one it asked for — give it time. That costs no request, which
   * is what makes it categorically different from the ambiguous case, where the
   * only way to learn anything is to fetch again.
   */
  describe('self-resolving interstitials', () => {
    /**
     * THE POINT. The page forwards itself while we wait, so the SAME load becomes
     * good — no second request is ever made. A reload here would have restarted the
     * very check that was about to pass.
     */
    it('waits for a holding page to forward itself, without reloading', async () => {
      const { adapter, throttle } = makeAdapter();
      // One driver.get; the page's own content changes underneath us, exactly as a
      // JS redirect does. Any second load would be the adapter's doing, not the page's.
      const { driver, loads } = makeDriver([INTERSTITIAL_PAGE], {
        becomes: GOOD_PAGE,
        afterMs: 10,
      });

      await expect(adapter.go(driver, URL, ctx())).resolves.toBeUndefined();
      expect(loads()).toBe(1); // waited, never re-fetched
      expect(throttle.backoffMsFor(URL)).toBe(0); // no wall was ever recorded
    });

    /** If waiting does not clear it, THEN a reload is fair — bounded as ever. */
    it('reloads once the wait expires, and still gives up at the bound', async () => {
      const { adapter, throttle } = makeAdapter();
      const { driver, loads } = makeDriver([
        INTERSTITIAL_PAGE,
        INTERSTITIAL_PAGE,
        INTERSTITIAL_PAGE,
      ]);

      await expect(adapter.go(driver, URL, ctx())).rejects.toThrow(
        BlockedError,
      );
      // 1 + CRAWL_MAX_BLOCK_RELOADS, same ceiling the ambiguous path obeys.
      expect(loads()).toBe(3);
      expect(throttle.backoffMsFor(URL)).toBeGreaterThan(0);
    });

    /**
     * THE ONE THAT KEEPS THIS HONEST.
     *
     * DataDome renders a page that looks like a holding page, and measurement says
     * it is not one: unchanged for 63s across two reloads. Waiting on it buys
     * nothing and makes every Etsy failure a minute slower to report, so it must be
     * treated as the explicit refusal it is — one load, no wait, no reload.
     */
    it('never waits on a DataDome challenge — it does not self-resolve', async () => {
      const { adapter } = makeAdapter();
      const { driver, loads } = makeDriver([DATADOME_PAGE, GOOD_PAGE]);

      const started = Date.now();
      await expect(adapter.go(driver, URL, ctx())).rejects.toThrow(
        /blocked the request/i,
      );

      expect(loads()).toBe(1);
      // Would be >= CRAWL_INTERSTITIAL_WAIT_MS if it had been treated as a holding page.
      expect(Date.now() - started).toBeLessThan(40);
    });

    /** Hardening mid-wait means the site answered: stop, do not spend the reload. */
    it('stops immediately if the interstitial turns into a refusal while waiting', async () => {
      const { adapter } = makeAdapter();
      const { driver, loads } = makeDriver([INTERSTITIAL_PAGE], {
        becomes: CAPTCHA_PAGE,
        afterMs: 10,
      });

      await expect(adapter.go(driver, URL, ctx())).rejects.toThrow(
        /blocked the request/i,
      );
      expect(loads()).toBe(1); // the remaining reloads were not spent
    });
  });
});
