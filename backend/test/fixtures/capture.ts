/**
 * Capture real marketplace HTML into fixtures.
 *
 *   npm run fixtures:capture -- ebay "vintage film camera"
 *   npm run fixtures:capture -- amazon "mechanical keyboard"
 *   npm run fixtures:capture -- etsy "handmade mug"
 *
 * Run this occasionally (and whenever test:canary goes red) to refresh the
 * frozen HTML that the adapter tests parse. The captured file replaces the
 * hand-authored placeholder and makes those tests meaningfully stronger: they
 * then assert against markup the site actually served.
 *
 * Headed on purpose (SELENIUM_HEADLESS is ignored here): you want to SEE what
 * was captured, and headless is more likely to be served an anti-bot page.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Builder } from 'selenium-webdriver';
import { Options as ChromeOptions } from 'selenium-webdriver/chrome';

const SEARCH_URLS: Record<string, (q: string) => string> = {
  amazon: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  ebay: (q) =>
    `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&_ipg=60`,
  etsy: (q) => `https://www.etsy.com/search?q=${encodeURIComponent(q)}`,
};

const BLOCK_MARKERS =
  /captcha|Pardon Our Interruption|Just a moment|Enter the characters you see|are you a robot/i;

async function main(): Promise<void> {
  const [site, ...queryParts] = process.argv.slice(2);
  const query = queryParts.join(' ');

  if (!site || !query || !SEARCH_URLS[site]) {
    console.error(
      'Usage: npm run fixtures:capture -- <amazon|ebay|etsy> "<search query>"',
    );
    process.exit(1);
  }

  const url = SEARCH_URLS[site](query);
  console.log(`Capturing ${url}`);

  const options = new ChromeOptions();
  options.addArguments(
    '--window-size=1920,1080',
    '--disable-blink-features=AutomationControlled',
  );
  const driver = await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .build();

  try {
    await driver.get(url);
    // Give lazy-loaded results time to render — capturing a skeleton screen
    // produces a fixture that tests nothing.
    await driver.sleep(5000);

    const html = await driver.getPageSource();

    if (BLOCK_MARKERS.test(html)) {
      // Saving this would be actively harmful: the adapter tests would then
      // "pass" against a CAPTCHA page, asserting nothing.
      console.error(
        '\nBLOCKED: the site served an anti-bot page. Nothing captured.',
      );
      console.error(
        'Try again later, from a different network, or use the official API.\n',
      );
      process.exit(2);
    }

    const dir = join(__dirname, site);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'search.html');
    await writeFile(file, html, 'utf8');

    console.log(`Wrote ${file} (${Math.round(html.length / 1024)} KB)`);
    console.log('Now run: npm test -- test/adapters');
    console.log(
      'If assertions fail, the real DOM differs from the placeholder — update the',
    );
    console.log(
      'expected values in the spec to match what the site actually returns.',
    );
  } finally {
    await driver.quit();
  }
}

void main();
