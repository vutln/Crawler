import { Builder, type WebDriver } from 'selenium-webdriver';
import { Options as ChromeOptions } from 'selenium-webdriver/chrome';

/**
 * A plain headless driver for fixture/E2E tests.
 *
 * Deliberately does NOT reuse WebDriverFactory: that class is a Nest provider
 * needing ConfigService, and standing up a DI container to parse an HTML file
 * would be silly. Selenium Manager still resolves chromedriver against the
 * installed Chrome, so there's nothing to pin here either.
 */
export async function createTestDriver(
  opts: { offline?: boolean } = {},
): Promise<WebDriver> {
  const { offline = false } = opts;

  const options = new ChromeOptions();
  options.addArguments(
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1920,1080',
  );
  options.excludeSwitches('enable-logging');

  if (offline) {
    // Captured fixtures are real pages: their HTML still references Amazon's
    // CDN scripts, fonts and images. Without this the "offline, deterministic"
    // fixture test actually hits the network on every run and hangs when those
    // hosts are slow — which is exactly the flakiness fixtures exist to avoid.
    //
    // Resolve every host to NOTFOUND except loopback, so subresources fail
    // instantly instead of waiting. The DOM we assert on is already in the file.
    options.addArguments(
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--disable-background-networking',
      '--disable-sync',
      '--no-first-run',
    );

    // 'eager' returns at DOMContentLoaded rather than waiting for every
    // subresource. We only ever assert on DOM structure, never on images.
    options.setPageLoadStrategy('eager');
  }

  const driver = await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .build();
  await driver.manage().setTimeouts({ pageLoad: 30_000, implicit: 0 });
  return driver;
}
