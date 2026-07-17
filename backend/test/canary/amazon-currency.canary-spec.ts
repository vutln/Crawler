import { Builder, type WebDriver, logging } from 'selenium-webdriver';
import { Options as ChromeOptions } from 'selenium-webdriver/chrome';

/**
 * US-MARKET CANARY — hits LIVE Amazon. Excluded from `npm test` and from CI.
 * Run deliberately:  npm run test:canary
 *
 * Why this exists: the project's entire "thị trường US" requirement rests on one
 * cookie. amazon.com is the US store, but it converts the DISPLAY currency to the
 * visitor's geolocated country — from this project's Vietnam egress a $12.99
 * shirt renders as VND, and the parser reads the display price. `i18n-prefs=USD`
 * tells Amazon to show the USD it already holds (the page embeds
 * `currencyCode":"USD"` underneath the VND all along).
 *
 * That is an assumption about someone else's system, held in a config file. It is
 * exactly the class of thing that works until it silently doesn't — the same
 * argument the eBay DOM canary makes about selectors. If Amazon stops honouring
 * i18n-prefs, every price in the database quietly becomes the wrong market, and
 * nothing else in the suite would notice: the fixture tier is frozen, and the
 * unit tests only prove we store whatever currency we were handed.
 *
 * Established by controlled experiment on 2026-07-17 (same code, same IP, same
 * URL, cookie the only variable):
 *    without the cookie -> 48 cards, VND
 *    with    the cookie -> 48 cards, USD
 *
 * A CAPTCHA / block result is INCONCLUSIVE, not a failure — asserting otherwise
 * would make the suite lie. Amazon soft-blocks intermittently from here.
 */

const URL = 'https://www.amazon.com/s?k=mechanical+keyboard';

/** Same shape WebDriverFactory declares — sendDevToolsCommand is on the Chromium driver, not the base type. */
type DevToolsWebDriver = WebDriver & {
  sendDevToolsCommand(command: string, parameters?: Record<string, unknown>): Promise<void>;
};

const BLOCK_MARKERS =
  /Enter the characters you see below|Sorry[!,.]?\s*Something went wrong|Something went wrong on our end|not a robot/i;

/** The visually-hidden span holding the whole price string — what the adapter reads. */
const OFFSCREEN_PRICE = /class="a-offscreen">([^<]{1,24})</g;

async function makeDriver(): Promise<DevToolsWebDriver> {
  // Mirrors WebDriverFactory.create(); this canary is only meaningful if it
  // reproduces what the real crawler does.
  const options = new ChromeOptions();
  options.addArguments(
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1920,1080',
    '--disable-blink-features=AutomationControlled',
    '--lang=en-US',
  );
  options.setUserPreferences({
    'profile.managed_default_content_settings.images': 2,
    'intl.accept_languages': 'en-US,en',
  });
  const prefs = new logging.Preferences();
  prefs.setLevel(logging.Type.BROWSER, logging.Level.OFF);
  options.setLoggingPrefs(prefs);
  options.excludeSwitches('enable-logging', 'enable-automation');

  const driver = (await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .build()) as DevToolsWebDriver;
  await driver.manage().setTimeouts({ pageLoad: 30_000, script: 30_000, implicit: 0 });
  return driver;
}

function currenciesIn(html: string): Set<string> {
  const found = new Set<string>();
  for (const [, price] of html.matchAll(OFFSCREEN_PRICE)) {
    if (/₫|VND/.test(price)) found.add('VND');
    else if (/\$/.test(price)) found.add('USD');
  }
  return found;
}

describe('CANARY: Amazon still honours i18n-prefs=USD', () => {
  let driver: DevToolsWebDriver;
  let html = '';
  let blocked = false;

  beforeAll(async () => {
    driver = await makeDriver();

    // Exactly what WebDriverFactory.create() does with CRAWL_COOKIES_JSON, in the
    // same order — Network.enable first, cookies BEFORE the first navigation, so
    // the very first response is already in USD. A canary that diverges from the
    // real driver setup would be testing something the crawler never does.
    await driver.sendDevToolsCommand('Network.enable');
    await driver.sendDevToolsCommand('Network.setCookies', {
      cookies: [
        { name: 'i18n-prefs', value: 'USD', domain: '.amazon.com', path: '/' },
        { name: 'lc-main', value: 'en_US', domain: '.amazon.com', path: '/' },
      ],
    });

    await driver.get(URL);
    html = await driver.getPageSource();
    blocked = BLOCK_MARKERS.test(html);

    if (blocked) {
      console.warn(
        '\n  CANARY INCONCLUSIVE: Amazon served an anti-bot / error page.' +
          '\n  This says nothing about the currency mechanism — try later.\n',
      );
    }
  }, 120_000);

  afterAll(async () => {
    await driver?.quit();
  });

  it('renders search results at all', async () => {
    if (blocked) return;
    const cards = (html.match(/data-component-type="s-search-result"/g) ?? []).length;
    expect(cards).toBeGreaterThan(0);
  });

  /**
   * The one that matters. If this goes red, the cookie has stopped working and
   * every Amazon price being collected is the wrong market — go read
   * .env.example's CRAWL_COOKIES_JSON note before assuming it's a test bug.
   */
  it('returns USD prices, not the IP-geolocated currency', async () => {
    if (blocked) return;

    const currencies = currenciesIn(html);
    expect(currencies.size).toBeGreaterThan(0);
    expect([...currencies]).toContain('USD');
    expect([...currencies]).not.toContain('VND');
  });
});
