import { Inject, Logger } from '@nestjs/common';
import { By, until, type WebDriver, type WebElement } from 'selenium-webdriver';
import type { Marketplace } from '../../generated/prisma/client';
import { BlockDetectorService } from '../politeness/block-detector.service';
import { RobotsService } from '../politeness/robots.service';
import { ThrottleService } from '../politeness/throttle.service';
import { WebDriverFactory } from '../driver/webdriver.factory';
import {
  BlockedError,
  type CrawlContext,
  type MarketplaceAdapter,
  type ProductRecord,
} from './adapter.interface';

/** A real "no results" page still carries nav and footer — hundreds of chars. */
const EMPTY_BODY_THRESHOLD = 50;

/**
 * Longest we'll idle with a browser attached rather than refuse the run.
 *
 * withDriver() launches Chrome before navigate() runs, so every wait inside
 * navigate() is a wait with a live browser parked on Chrome's blank `data:,`
 * page, holding one of SELENIUM_MAX_DRIVERS slots. A few seconds of that is
 * ordinary pacing. A post-block cooldown is minutes, and with
 * SELENIUM_HEADLESS=false it's a visibly frozen window.
 */
const MAX_IDLE_HOLD_MS = 15_000;

/**
 * Robots gating, throttling, block detection and navigation.
 * Subclasses implement parsing only.
 */
export abstract class SeleniumAdapterBase implements MarketplaceAdapter {
  abstract readonly marketplace: Marketplace;
  abstract readonly name: string;

  /** Selenium adapters sit below API adapters (priority 100) by default. */
  readonly priority: number = 10;

  readonly capabilities = { search: true, productDetail: true };

  protected readonly logger: Logger;

  /**
   * Property injection is required here, not a style choice. TypeScript only
   * emits `design:paramtypes` for a class declaring its OWN constructor, so a
   * subclass that merely inherits one gets no metadata and Nest constructs it
   * with zero arguments — every dependency silently `undefined` until a crawl
   * dereferences it. @Inject on the property inherits correctly.
   *
   * These are populated after construction; never touch them in a constructor.
   */
  @Inject(WebDriverFactory) protected readonly drivers!: WebDriverFactory;
  @Inject(RobotsService) protected readonly robots!: RobotsService;
  @Inject(ThrottleService) protected readonly throttle!: ThrottleService;
  @Inject(BlockDetectorService) protected readonly blockDetector!: BlockDetectorService;

  constructor() {
    this.logger = new Logger(this.constructor.name);
  }

  /** Scraping needs no credentials, so a Selenium adapter is always usable. */
  isAvailable(): boolean {
    return true;
  }

  abstract search(ctx: CrawlContext): AsyncIterable<ProductRecord>;
  abstract fetchProduct(url: string, ctx: CrawlContext): Promise<ProductRecord | null>;

  /**
   * The only sanctioned way to load a page. Order matters: robots (don't fetch
   * what we're told not to), throttle (pace what we may), then block-check.
   */
  protected async navigate(driver: WebDriver, url: string, ctx: CrawlContext): Promise<void> {
    if (ctx.signal.aborted) throw new Error('Aborted');

    const allowed = await this.robots.isAllowed(url);
    if (!allowed) {
      throw new Error(`robots.txt disallows ${url} for our user-agent`);
    }

    // Site-declared pacing outranks our own floor when it is stricter. Reads the
    // same 1h robots cache isAllowed() just populated, so it costs no extra fetch.
    const declaredDelay = await this.robots.crawlDelayMs(url);
    if (declaredDelay !== null) this.throttle.setHostFloor(url, declaredDelay);

    // Say so and stop, rather than idle a browser through a cooldown.
    //
    // The cooldown is NOT skipped or shortened by this — the host stays owed and
    // the clock keeps running. This only decides how we spend the wait: a run
    // that reports "cooling down, 118s left" in two seconds is more useful than
    // one that shows RUNNING for two minutes behind a blank window.
    //
    // Backoff only, not total owed time: a Crawl-delay above MAX_IDLE_HOLD_MS is a
    // polite site being honoured, and charging it here would report a block that
    // never happened and refuse every crawl of that host.
    const owed = this.throttle.owedBackoffMsFor(url);
    if (owed > MAX_IDLE_HOLD_MS) {
      throw new BlockedError(
        `${this.marketplace} is ${Math.round(owed / 1000)}s into a cooldown from an earlier ` +
          `block — not knocking again yet.`,
        `owedMs=${owed} url=${url}`,
      );
    }

    await this.throttle.acquire(url, ctx.signal);

    try {
      await driver.get(url);
    } catch (err) {
      this.throttle.recordFailure(url);
      throw err;
    }

    await this.assertNotBlocked(driver, url);
    this.throttle.recordSuccess(url);
  }

  /** A blocked page returns HTTP 200 with a parseable DOM — the status tells you nothing. */
  protected async assertNotBlocked(driver: WebDriver, context: string): Promise<void> {
    const [html, title, currentUrl] = await Promise.all([
      driver.getPageSource().catch(() => ''),
      driver.getTitle().catch(() => ''),
      driver.getCurrentUrl().catch(() => ''),
    ]);

    const signal = this.blockDetector.inspect({ html, title, url: currentUrl });
    if (signal.blocked) {
      this.blockDetector.logIfBlocked(signal, context);
      // recordBlock, not recordFailure: a wall costs several backoff steps. Keyed
      // off the URL we navigated to — `context` here is that URL, and safeHostname
      // needs a real one.
      this.throttle.recordBlock(context);
      throw new BlockedError(
        `${this.marketplace} blocked the request: ${signal.reason}`,
        signal.evidence,
      );
    }
  }

  /** Wait for a container proving the page rendered. Absence is a valid outcome. */
  protected async waitForAny(
    driver: WebDriver,
    selectors: string[],
    timeoutMs = 15_000,
  ): Promise<boolean> {
    try {
      await driver.wait(until.elementLocated(By.css(selectors.join(', '))), timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A search page with no result containers is one of three things, and they
   * look identical from outside: genuinely no matches, DOM drift, or a wall.
   * Throws BlockedError when the evidence for a wall is conclusive.
   *
   * An empty body is conclusive because waitForAny already gave the page a full
   * timeout. Zero characters after 15s isn't a slow page; it's a JS challenge
   * that rendered nothing — and no signature can match a page with no text.
   */
  protected async diagnoseEmptyPage(driver: WebDriver, context: string): Promise<void> {
    const [title, currentUrl, bodyText, html] = await Promise.all([
      driver.getTitle().catch(() => ''),
      driver.getCurrentUrl().catch(() => ''),
      driver
        .findElement(By.css('body'))
        .getText()
        .catch(() => ''),
      driver.getPageSource().catch(() => ''),
    ]);

    const text = bodyText.replace(/\s+/g, ' ').trim();

    // Redirects have settled by now; the URL may carry a challenge marker that
    // wasn't there at navigate() time.
    const signal = this.blockDetector.inspect({ html, title, url: currentUrl });
    if (signal.blocked) {
      this.blockDetector.logIfBlocked(signal, context);
      this.recordBlockFor(currentUrl);
      throw new BlockedError(
        `${this.marketplace} blocked the request: ${signal.reason}`,
        signal.evidence,
      );
    }

    if (text.length < EMPTY_BODY_THRESHOLD) {
      this.logger.warn(`${context}: empty body after full render timeout — treating as blocked`);
      this.recordBlockFor(currentUrl);
      throw new BlockedError(
        `${this.marketplace} served a page with no content — almost certainly a JavaScript ` +
          `anti-bot challenge (the body never rendered).`,
        `title="${title}" url=${currentUrl} bodyChars=${text.length}`,
      );
    }

    // Real content, no known signature: genuine empty results or DOM drift.
    // Log enough to tell those apart later.
    this.logger.warn(
      `${context}: no result containers, but the page has content (${text.length} chars).\n` +
        `  title: ${title}\n` +
        `  url:   ${currentUrl}\n` +
        `  text:  ${text.slice(0, 240)}`,
    );
  }

  /**
   * Charge a wall against the domain's backoff.
   *
   * Split out because diagnoseEmptyPage's `context` is a human label ("Amazon
   * page 2"), not a URL — passing it to the throttle would key the backoff under
   * a bogus host and silently record nothing useful. The driver's current URL is
   * the only real one available here, and it's empty only if the driver died, in
   * which case there's no host to charge.
   */
  private recordBlockFor(currentUrl: string): void {
    if (currentUrl) this.throttle.recordBlock(currentUrl);
  }

  /**
   * First matching selector's text, else undefined. Never throws.
   *
   * The textContent fallback is load-bearing: getText() returns only *visible*
   * text, and Amazon hides its price in `.a-offscreen` and its rating in
   * `.a-icon-alt`, both clipped to 0x0. Without it every price parses to null.
   */
  protected async textOf(scope: WebElement, selectors: string[]): Promise<string | undefined> {
    for (const selector of selectors) {
      try {
        const el = await scope.findElement(By.css(selector));

        const visible = (await el.getText()).trim();
        if (visible) return visible;

        const raw = (await el.getAttribute('textContent'))?.trim();
        if (raw) return raw;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /** First matching selector's attribute, else undefined. Never throws. */
  protected async attrOf(
    scope: WebElement,
    selectors: string[],
    attribute: string,
  ): Promise<string | undefined> {
    for (const selector of selectors) {
      try {
        const el = await scope.findElement(By.css(selector));
        const value = await el.getAttribute(attribute);
        if (value) return value.trim();
      } catch {
        continue;
      }
    }
    return undefined;
  }
}
