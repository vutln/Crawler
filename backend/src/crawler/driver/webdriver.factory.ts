import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Builder, type WebDriver, logging } from 'selenium-webdriver';
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

  /** Resolvers waiting for a slot when maxDrivers is saturated. */
  private readonly waiters: Array<() => void> = [];
  private leased = 0;

  constructor(private readonly config: ConfigService) {
    this.headless = this.config.get<boolean>('SELENIUM_HEADLESS', true);
    this.timeoutMs = this.config.get<number>('SELENIUM_TIMEOUT_MS', 30_000);
    this.maxDrivers = this.config.get<number>('SELENIUM_MAX_DRIVERS', 2);
    this.userAgent = this.config.get<string>('CRAWL_USER_AGENT', '');

    this.extraHeaders = this.validateExtraHeaders(
      this.parseJson<Record<string, string>>('CRAWL_EXTRA_HEADERS_JSON', {}),
    );

    this.seedCookies = this.parseJson<SeedCookie[]>('CRAWL_COOKIES_JSON', []);
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
  async withDriver<T>(fn: (driver: WebDriver) => Promise<T>): Promise<T> {
    await this.acquireSlot();
    let driver: WebDriver | undefined;
    try {
      driver = await this.create();
      return await fn(driver);
    } finally {
      if (driver) await this.quit(driver);
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.leased < this.maxDrivers) {
      this.leased++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.leased++;
  }

  private releaseSlot(): void {
    this.leased--;
    this.waiters.shift()?.();
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
