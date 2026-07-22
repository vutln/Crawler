import { By } from 'selenium-webdriver';
import type { WebDriver } from 'selenium-webdriver';
import { createTestDriver } from '../fixtures/test-driver';

/**
 * DOM DRIFT CANARY — hits the LIVE site. Excluded from `npm test` and from CI.
 * Run deliberately:  npm run test:canary
 *
 * Why this exists: fixture tests are deterministic precisely because the HTML is
 * frozen — which means they will happily stay green forever while the real eBay
 * markup drifts out from under our selectors. Fixtures verify the parser;
 * this verifies the ASSUMPTIONS the fixtures encode.
 *
 * It is expected to be flaky. That's inherent to touching a live, A/B-tested,
 * bot-hostile site, and it's exactly why it must never gate CI. A failure here
 * means "go look", not "the build is broken". A CAPTCHA result is inconclusive,
 * not a failure — asserting otherwise would make the suite lie.
 */

const SELECTORS_UNDER_TEST = {
  resultItem: 'li.s-item, li.s-card, ul.srp-results > li[data-viewport]',
  title: '.s-item__title, .s-card__title, h3.s-item__title, [role="heading"]',
  price: '.s-item__price, .s-card__price',
  link: 'a.s-item__link, a.s-card__link, a[href*="/itm/"]',
};

const CAPTCHA_MARKERS =
  /Pardon Our Interruption|splashui\/captcha|Just a moment|are you a robot/i;

describe('CANARY: eBay live DOM still matches our selectors', () => {
  let driver: WebDriver;
  let html = '';
  let blocked = false;

  beforeAll(async () => {
    driver = await createTestDriver();
    await driver.get(
      'https://www.ebay.com/sch/i.html?_nkw=vintage+film+camera&_ipg=60',
    );
    html = await driver.getPageSource();
    blocked = CAPTCHA_MARKERS.test(html);

    if (blocked) {
      console.warn(
        '\n  CANARY INCONCLUSIVE: eBay served an anti-bot page.' +
          '\n  This says nothing about our selectors — try later or from another network.\n',
      );
    }
  }, 120_000);

  afterAll(async () => {
    await driver?.quit();
  });

  it('finds search result containers', async () => {
    if (blocked) return;
    const items = await driver.findElements(
      By.css(SELECTORS_UNDER_TEST.resultItem),
    );
    expect(items.length).toBeGreaterThan(0);
  });

  it('finds a title inside a result', async () => {
    if (blocked) return;
    const items = await driver.findElements(
      By.css(SELECTORS_UNDER_TEST.resultItem),
    );
    const titles = await items[0].findElements(
      By.css(SELECTORS_UNDER_TEST.title),
    );
    expect(titles.length).toBeGreaterThan(0);
  });

  it('finds a price inside a result', async () => {
    if (blocked) return;
    const items = await driver.findElements(
      By.css(SELECTORS_UNDER_TEST.resultItem),
    );

    // Scan a few: the first card is sometimes an ad or a promo row with no price.
    let found = 0;
    for (const item of items.slice(0, 5)) {
      found += (await item.findElements(By.css(SELECTORS_UNDER_TEST.price)))
        .length;
    }
    expect(found).toBeGreaterThan(0);
  });

  it('finds item links matching our id-extraction pattern', async () => {
    if (blocked) return;
    const links = await driver.findElements(By.css(SELECTORS_UNDER_TEST.link));
    expect(links.length).toBeGreaterThan(0);

    const hrefs = await Promise.all(
      links.slice(0, 5).map((l) => l.getAttribute('href')),
    );
    // If this regex stops matching, extractItemId() in the adapter is silently
    // dropping every listing — the single highest-impact drift failure.
    expect(
      hrefs.some((h) => /\/itm\/(?:[^/]+\/)?(\d{9,15})/.test(h ?? '')),
    ).toBe(true);
  });
});
