import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { By, until, type WebDriver, type WebElement } from 'selenium-webdriver';
import type { Marketplace } from '../../generated/prisma/client';
import { BlockDetectorService, type BlockSignal } from '../politeness/block-detector.service';
import { RobotsService } from '../politeness/robots.service';
import { ThrottleService, sleep } from '../politeness/throttle.service';
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
 * Reloads allowed for an AMBIGUOUS block signal — so at most 1 + this many loads.
 *
 * Only ever applied to a signal the detector marks ambiguous; an explicit refusal
 * is never reloaded at all. The number is a budget for disambiguating a page, not
 * a persistence dial: raising it does not improve the odds of getting in, it just
 * knocks more times before admitting the answer. Anything much above this stops
 * being "look again" and becomes a retry loop against a site that may be refusing
 * us, which is what deepens the throttle.
 */
/**
 * How often to re-check a holding page while waiting it out.
 *
 * Not configurable: it is a polling granularity, not a policy. The policy knobs
 * are CRAWL_INTERSTITIAL_WAIT_MS (how long we are willing to wait) and
 * CRAWL_MAX_BLOCK_RELOADS (how many times we try at all). Polling costs nothing —
 * it reads the DOM already in the browser — so this only decides how quickly we
 * notice the site has forwarded us.
 */
const INTERSTITIAL_POLL_MS = 2_000;

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
  @Inject(ConfigService) protected readonly config!: ConfigService;

  /**
   * Read through getters, not fields: these properties are injected AFTER
   * construction (see the note above), so a field initialiser would capture
   * `undefined` from a config that does not exist yet.
   */
  private get maxBlockReloads(): number {
    return this.config.get<number>('CRAWL_MAX_BLOCK_RELOADS', 2);
  }

  private get interstitialWaitMs(): number {
    return this.config.get<number>('CRAWL_INTERSTITIAL_WAIT_MS', 20_000);
  }

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
        owed,
      );
    }

    await this.throttle.acquire(url, ctx.signal);
    await this.load(driver, url);

    let signal = await this.inspectPage(driver);

    /**
     * Up to CRAWL_MAX_BLOCK_RELOADS reloads, and ONLY for a signal the detector
     * marks recoverable — so at most 1 + that many loads in total.
     *
     * TWO kinds of signal qualify, and they are handled differently because they
     * are asking for different things:
     *
     * AMBIGUOUS — the marketplace error page ("Sorry! Something went wrong"), which
     * is served both for genuine 5xx blips and as a soft block. One sample cannot
     * tell them apart, so the answer is to fetch it again. Amazon has been observed
     * serving this on a cold hit and rendering normally on reload.
     *
     * SELF-RESOLVING — a "checking your browser" interstitial that runs a JS check
     * and then forwards to the page we asked for. It has already told us what it
     * is; the answer is to WAIT, which costs no request at all. Reloading one of
     * these is actively counterproductive, since it restarts the check that was
     * already running. Only after the wait expires do we reload.
     *
     * The boundary matters more than the count. An EXPLICIT refusal — CAPTCHA,
     * DataDome, an automated-access notice — is never waited on OR reloaded: the
     * site answered in words, and asking again is a retry loop, which is the thing
     * that deepens the throttle and the thing this codebase refuses to do. We also
     * do not change anything about ourselves between attempts: same driver, same
     * cookies, same headers, same identity. The loop condition keeps that honest —
     * the moment a signal stops being recoverable, this stops, whether it cleared
     * or hardened into an explicit refusal.
     *
     * Costed like any other request: each reload goes through throttle.acquire(),
     * so the per-host floor is paid again before every knock. The WAIT is not
     * costed, because it is not a request.
     */
    for (
      let reload = 1;
      reload <= this.maxBlockReloads &&
      signal.blocked &&
      (signal.ambiguous || signal.selfResolving);
      reload++
    ) {
      if (ctx.signal.aborted) throw new Error('Aborted');

      // A holding page gets the wait it asked for BEFORE we spend a request on it.
      if (signal.selfResolving) {
        signal = await this.waitOutInterstitial(driver, url, signal);

        // Stop unless the wait left us with something a reload could still help.
        // Checking only `!signal.blocked` was a bug: an interstitial that hardened
        // into a CAPTCHA mid-wait is blocked AND unrecoverable, so it fell through
        // and got reloaded — the exact retry-against-an-explicit-refusal this
        // whole design refuses to do.
        const recoverable = signal.ambiguous || signal.selfResolving;
        if (!signal.blocked || !recoverable) break;
      }

      this.logger.warn(
        `${url}: ${signal.reason} — look ${reload + 1} of ` +
          `${this.maxBlockReloads + 1} before calling it a wall`,
      );

      await this.throttle.acquire(url, ctx.signal);
      await this.load(driver, url);
      signal = await this.inspectPage(driver);

      if (!signal.blocked) {
        this.logger.log(
          `${url}: cleared on look ${reload + 1} — transient, not a wall`,
        );
      }
    }

    if (signal.blocked) {
      this.blockDetector.logIfBlocked(signal, url);
      // recordBlock, not recordFailure: a wall costs several backoff steps.
      this.throttle.recordBlock(url);
      throw new BlockedError(
        `${this.marketplace} blocked the request: ${signal.reason}`,
        signal.evidence,
        // Read AFTER recordBlock, so it reflects the wall we just took.
        this.throttle.owedBackoffMsFor(url),
      );
    }

    this.throttle.recordSuccess(url);
  }

  /**
   * Let a "checking your browser" interstitial finish on its own.
   *
   * Polls the page in place rather than sleeping blind, so the moment the site
   * forwards us we carry on instead of waiting out the full window. No request is
   * made here at all — the browser is simply given the time the page asked for,
   * which is the politest available response to a holding page and the one a human
   * visitor would give it.
   *
   * Returns the latest signal: cleared if it resolved, the original if it did not.
   */
  private async waitOutInterstitial(
    driver: WebDriver,
    url: string,
    initial: BlockSignal,
  ): Promise<BlockSignal> {
    if (this.interstitialWaitMs <= 0) return initial;

    this.logger.warn(
      `${url}: ${initial.reason} — a holding page, waiting up to ` +
        `${Math.round(this.interstitialWaitMs / 1000)}s for it to forward us`,
    );

    const deadline = Date.now() + this.interstitialWaitMs;
    let signal = initial;

    while (Date.now() < deadline) {
      await sleep(Math.min(INTERSTITIAL_POLL_MS, deadline - Date.now()));
      signal = await this.inspectPage(driver);

      if (!signal.blocked) {
        this.logger.log(`${url}: the interstitial forwarded us — no wall here`);
        return signal;
      }
      // Hardened into something explicit while we waited: stop, do not reload.
      if (!signal.selfResolving && !signal.ambiguous) return signal;
    }

    return signal;
  }

  /** driver.get with the throttle's failure bookkeeping. Caller must have acquired first. */
  private async load(driver: WebDriver, url: string): Promise<void> {
    try {
      await driver.get(url);
    } catch (err) {
      this.throttle.recordFailure(url);
      throw err;
    }
  }

  /**
   * Read the rendered page and classify it. Pure observation — no throwing, no
   * throttle bookkeeping, so navigate() can call it twice and decide once.
   *
   * A blocked page returns HTTP 200 with a perfectly parseable DOM; the status
   * code tells you nothing. The body is the only evidence there is.
   */
  private async inspectPage(driver: WebDriver): Promise<BlockSignal> {
    const [html, title, currentUrl] = await Promise.all([
      driver.getPageSource().catch(() => ''),
      driver.getTitle().catch(() => ''),
      driver.getCurrentUrl().catch(() => ''),
    ]);
    return this.blockDetector.inspect({ html, title, url: currentUrl });
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
