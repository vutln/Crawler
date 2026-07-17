import type { WebDriver } from 'selenium-webdriver';
import { Marketplace } from '../../generated/prisma/client';
import { BlockDetectorService } from '../politeness/block-detector.service';
import { RobotsService } from '../politeness/robots.service';
import { ThrottleService } from '../politeness/throttle.service';
import { WebDriverFactory } from '../driver/webdriver.factory';
import { BlockedError, type CrawlContext, type ProductRecord } from './adapter.interface';
import { SeleniumAdapterBase } from './selenium-adapter.base';

/**
 * navigate()'s block handling — specifically the one-retry rule.
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

  /** Serves `pages` in order, one per driver.get(). Records how many loads happened. */
  function makeDriver(pages: string[]): { driver: WebDriver; loads: () => number } {
    let i = 0;
    let current = '';
    const driver = {
      get: (_url: string) => {
        current = pages[Math.min(i, pages.length - 1)];
        i++;
        return Promise.resolve();
      },
      getPageSource: () => Promise.resolve(current),
      getTitle: () => Promise.resolve(/<title>([^<]*)</.exec(current)?.[1] ?? ''),
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
        ({ CRAWL_MIN_DELAY_MS: 1, CRAWL_MAX_BACKOFF_MS: 1000 })[key] ?? fallback,
    } as never;

    const throttle = new ThrottleService(config);
    const adapter = new TestAdapter();

    // Property injection: Nest would do this, and the properties are declared with
    // `!` so the compiler can't help us here. Mirrors what crawler.module wires.
    Object.assign(adapter, {
      drivers: {} as WebDriverFactory,
      robots: { isAllowed: () => Promise.resolve(true), crawlDelayMs: () => Promise.resolve(null) } as unknown as RobotsService,
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
      logger: { log: () => {}, warn: () => {}, error: () => {} } as never,
    } as CrawlContext;
  }

  it('loads a clean page once and records a success', async () => {
    const { adapter, throttle } = makeAdapter();
    const { driver, loads } = makeDriver([GOOD_PAGE]);

    await expect(adapter.go(driver, URL, ctx())).resolves.toBeUndefined();
    expect(loads()).toBe(1);
    expect(throttle.backoffMsFor(URL)).toBe(0);
  });

  /**
   * The reason the retry exists: the error page cleared on a second look, so it
   * was a blip. Previously this cost 6 backoff steps and failed the whole run.
   */
  it('takes a second look at the ambiguous error page and proceeds when it clears', async () => {
    const { adapter, throttle } = makeAdapter();
    const { driver, loads } = makeDriver([DOGS_PAGE, GOOD_PAGE]);

    await expect(adapter.go(driver, URL, ctx())).resolves.toBeUndefined();
    expect(loads()).toBe(2);
    // Transient, so nothing is owed: no wall was ever recorded.
    expect(throttle.backoffMsFor(URL)).toBe(0);
  });

  it('calls it a wall when the error page persists, and charges the full backoff', async () => {
    const { adapter, throttle } = makeAdapter();
    const { driver, loads } = makeDriver([DOGS_PAGE, DOGS_PAGE]);

    await expect(adapter.go(driver, URL, ctx())).rejects.toThrow(BlockedError);
    // Exactly one retry — never a third knock.
    expect(loads()).toBe(2);
    expect(throttle.backoffMsFor(URL)).toBeGreaterThan(0);
  });

  /**
   * THE IMPORTANT ONE.
   *
   * A CAPTCHA is the site refusing us in words. Retrying it would be re-asking a
   * question that was already answered — a retry loop, and the precise behaviour
   * this project declines to implement. The one-retry rule must never widen to
   * cover explicit refusals, so this asserts a single load and an immediate wall.
   */
  it('never knocks twice on an explicit refusal', async () => {
    const { adapter, throttle } = makeAdapter();
    const { driver, loads } = makeDriver([CAPTCHA_PAGE, GOOD_PAGE]);

    await expect(adapter.go(driver, URL, ctx())).rejects.toThrow(/blocked the request/i);
    // Would be 2 if the retry ever leaked past the `ambiguous` guard — and note the
    // second page is GOOD, so a leaky retry would have silently "succeeded".
    expect(loads()).toBe(1);
    expect(throttle.backoffMsFor(URL)).toBeGreaterThan(0);
  });

  it('does not retry on an aborted run', async () => {
    const { adapter } = makeAdapter();
    const { driver, loads } = makeDriver([DOGS_PAGE, GOOD_PAGE]);

    const controller = new AbortController();
    const aborted = { ...ctx(), signal: controller.signal } as CrawlContext;
    controller.abort();

    await expect(adapter.go(driver, URL, aborted)).rejects.toThrow(/abort/i);
    expect(loads()).toBe(0);
  });
});
