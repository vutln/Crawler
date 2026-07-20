import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Builder, type WebDriver, logging } from 'selenium-webdriver';
import { Marketplace } from '../../generated/prisma/client';
import { Options as ChromeOptions } from 'selenium-webdriver/chrome';

type SameSite = 'Strict' | 'Lax' | 'None';

interface SeedCookie {
  name: string;
  value: string;

  // CDP can use url to determine the cookie domain before visiting the site.
  url?: string;
  domain?: string;
  path?: string;

  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: SameSite;

  // Seconds since Unix epoch.
  expires?: number;
}

type DevToolsWebDriver = WebDriver & {
  sendDevToolsCommand(
    command: string,
    parameters?: Record<string, unknown>,
  ): Promise<void>;
};

/**
 * Owns every WebDriver in the process.
 *
 * Do NOT add the `chromedriver` npm package: Selenium Manager resolves a driver
 * matching the *installed* Chrome at runtime. A pinned driver goes stale the
 * moment Chrome auto-updates and every crawl dies with a version mismatch.
 *
 * An un-quit driver leaks both chrome.exe and chromedriver.exe on Windows, so
 * every instance is tracked and killed in onModuleDestroy.
 */
@Injectable()
export class WebDriverFactory implements OnModuleDestroy {
  private readonly logger = new Logger(WebDriverFactory.name);
  private readonly live = new Set<WebDriver>();

  private readonly headless: boolean;
  private readonly timeoutMs: number;
  private readonly maxDrivers: number;
  private readonly userAgent: string;

  private readonly extraHeaders: Record<string, string>;
  private readonly seedCookies: SeedCookie[];

  /**
   * Callers waiting for a slot when maxDrivers is saturated.
   *
   * Both halves are kept, not just `resolve`: a waiter whose signal aborts has to
   * be rejected AND spliced out, or releaseSlot would eventually hand a browser to
   * someone who stopped waiting and never release it.
   */
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  private leased = 0;

  constructor(private readonly config: ConfigService) {
    this.headless = this.config.get<boolean>('SELENIUM_HEADLESS', true);
    this.timeoutMs = this.config.get<number>('SELENIUM_TIMEOUT_MS', 30_000);
    // Fallback matches env.validation's default. It read 2 while the validated
    // default was 3 — harmless while ConfigModule always supplies a value, and a
    // silent 2 for anything constructing this without one.
    this.maxDrivers = this.config.get<number>('SELENIUM_MAX_DRIVERS', 3);
    this.userAgent = this.config.get<string>('CRAWL_USER_AGENT', '');

    this.extraHeaders = this.validateExtraHeaders(
      this.parseJson<Record<string, string>>('CRAWL_EXTRA_HEADERS_JSON', {}),
    );

    this.seedCookies = this.parseJson<SeedCookie[]>('CRAWL_COOKIES_JSON', []);
    this.warnIfPoolStarvesLanes();
  }

  /**
   * The queue runs one lane per marketplace, concurrently. Each lane holds a
   * browser for the whole run, so a pool smaller than the lane count means lanes
   * queue on drivers instead of running — the third marketplace simply waits.
   *
   * A warning, not a validation error: the env comment documents turning this DOWN
   * on a small box (~200-400MB per Chrome), and that is a legitimate trade. What is
   * not legitimate is making it silently. The symptom otherwise reads as "Etsy jobs
   * never run, no error" — which is invisible in the dashboard, because the runs are
   * genuinely QUEUED and genuinely waiting.
   */
  private warnIfPoolStarvesLanes(): void {
    const lanes = Object.keys(Marketplace).length;
    if (this.maxDrivers >= lanes) return;

    this.logger.warn(
      `SELENIUM_MAX_DRIVERS=${this.maxDrivers} is below the ${lanes} crawl lanes ` +
        `(one per marketplace), so lanes will take turns waiting for a browser ` +
        `rather than running concurrently. Raise it to ${lanes} for full throughput, ` +
        `or keep it low deliberately to save memory.`,
    );
  }

  private parseJson<T>(key: string, fallback: T): T {
    const raw = this.config.get<string>(key, '');

    if (!raw) {
      return fallback;
    }

    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new Error(
        `${key} must contain valid JSON: ${(error as Error).message}`,
      );
    }
  }

  private readonly forbiddenExtraHeaders = new Set([
    'accept-encoding',
    'connection',
    'content-length',
    'cookie',
    'host',
    'origin',
    'referer',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-fetch-user',
    'transfer-encoding',
  ]);

  private validateExtraHeaders(
    headers: Record<string, string>,
  ): Record<string, string> {
    const validated: Record<string, string> = {};

    for (const [name, value] of Object.entries(headers)) {
      const normalizedName = name.trim().toLowerCase();

      if (!normalizedName) {
        throw new Error('Custom header name cannot be empty');
      }

      if (this.forbiddenExtraHeaders.has(normalizedName)) {
        throw new Error(
          `Do not manually set "${name}"; Chrome must generate it`,
        );
      }

      if (
        typeof value !== 'string' ||
        value.includes('\r') ||
        value.includes('\n')
      ) {
        throw new Error(`Invalid value for custom header "${name}"`);
      }

      validated[name] = value;
    }

    return validated;
  }

  /** Borrow a driver and always give it back — any early return would leak a browser. */
  async withDriver<T>(
    fn: (driver: WebDriver) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.acquireSlot(signal);
    let driver: WebDriver | undefined;
    try {
      driver = await this.create();
      return await fn(driver);
    } finally {
      if (driver) await this.quit(driver);
      this.releaseSlot();
    }
  }

  /**
   * The same lease, for a caller that STREAMS rather than returns.
   *
   * withDriver takes a callback returning Promise<T>, so you cannot `yield` from
   * inside it. That one fact is why an adapter wanting a single browser across all
   * its pages has to collect every record and hand back an array — and a run
   * blocked on page 2 then discards page 1's rows with the stack, reporting
   * itemsFound: 0 because the pipeline never saw them.
   *
   * `yield*` inside try/finally fixes that without giving up the lease guarantee:
   * when the consumer stops early — `for await (…) break`, which CrawlRunnerService
   * does on maxItems and on abort — the runtime calls .return() on this generator,
   * which runs the finally. Verified by spec, because getting it wrong leaks
   * chrome.exe AND chromedriver.exe on Windows and strands the next run on a slot
   * that is never released.
   *
   * Note the lease is acquired lazily, on first iteration rather than at call time.
   * A generator body does not run until pulled, which is strictly better here: an
   * adapter that builds an iterable and never iterates it now costs nothing.
   */
  async *withDriverIterable<T>(
    fn: (driver: WebDriver) => AsyncIterable<T>,
    signal?: AbortSignal,
  ): AsyncIterable<T> {
    await this.acquireSlot(signal);
    let driver: WebDriver | undefined;
    try {
      driver = await this.create();
      yield* fn(driver);
    } finally {
      if (driver) await this.quit(driver);
      this.releaseSlot();
    }
  }

  /**
   * Wait for a browser slot, abortably.
   *
   * The wait used to be a bare `new Promise(resolve => waiters.push(resolve))` with
   * no way out. That is survivable while leases are short, and becomes a hang the
   * moment they last a whole run: a starved caller is not awaiting anything the run
   * watchdog can interrupt, so CRAWL_RUN_TIMEOUT_MS fires `controller.abort()` and
   * nothing happens — the lane sits there until the process restarts.
   */
  private async acquireSlot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Aborted');

    if (this.leased < this.maxDrivers) {
      this.leased++;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);

      signal?.addEventListener(
        'abort',
        () => {
          // Drop ourselves from the queue, or releaseSlot would later hand a slot
          // to a caller that has already given up and leak it permanently.
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error('Aborted while waiting for a browser'));
        },
        { once: true },
      );
    });

    // Only past the await — a rejected wait never held a slot to release.
    this.leased++;
  }

  private releaseSlot(): void {
    this.leased--;
    this.waiters.shift()?.resolve();
  }

  private async create(): Promise<WebDriver> {
    const options = new ChromeOptions();

    if (this.headless) options.addArguments('--headless=new');

    options.addArguments(
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US',
    );

    // Empty CRAWL_USER_AGENT means "send Chrome's own string"
    // (HeadlessChrome/NNN), which is the truth about what this client is.
    // Amazon returns the same listings for a non-browser UA but strips every
    // price, so this default is load-bearing. See README.
    if (this.userAgent) {
      options.addArguments(`--user-agent=${this.userAgent}`);
    }

    // We want the src attribute, never the pixels. Big speedup.
    options.setUserPreferences({
      'profile.managed_default_content_settings.images': 2,
      'intl.accept_languages': 'en-US,en',
    });

    // setLevel() returns void, so this cannot be chained.
    const loggingPrefs = new logging.Preferences();
    loggingPrefs.setLevel(logging.Type.BROWSER, logging.Level.OFF);
    options.setLoggingPrefs(loggingPrefs);

    options.excludeSwitches('enable-logging', 'enable-automation');

    const driver = (await new Builder()
      .forBrowser('chrome')
      .setChromeOptions(options)
      .build()) as DevToolsWebDriver;

    await driver.sendDevToolsCommand('Network.enable');

    if (Object.keys(this.extraHeaders).length > 0) {
      await driver.sendDevToolsCommand('Network.setExtraHTTPHeaders', {
        headers: this.extraHeaders,
      });
    }

    if (this.seedCookies.length > 0) {
      await driver.sendDevToolsCommand('Network.setCookies', {
        cookies: this.seedCookies,
      });
    }

    await driver.manage().setTimeouts({
      pageLoad: this.timeoutMs,
      script: this.timeoutMs,
      implicit: 0, // implicit waits interact badly with explicit ones
    });

    this.live.add(driver);
    return driver;
  }

  private async quit(driver: WebDriver): Promise<void> {
    this.live.delete(driver);
    try {
      await driver.quit();
    } catch (err) {
      // Must not mask the crawl's real error.
      this.logger.warn(`driver.quit() failed: ${(err as Error).message}`);
    }
  }

  /** Last line of defence against orphaned chrome.exe/chromedriver.exe. */
  async onModuleDestroy(): Promise<void> {
    if (this.live.size === 0) return;
    this.logger.log(`Shutting down ${this.live.size} live driver(s)`);
    await Promise.allSettled([...this.live].map((d) => this.quit(d)));
  }
}
