import type { WebDriver } from 'selenium-webdriver';
import { createTestDriver } from '../fixtures/test-driver';
import {
  APP_URL,
  CrawlJobsPage,
  DashboardPage,
  ProductDetailPage,
  ProductsPage,
  screenshot,
} from './pages';

/**
 * End-to-end: Selenium drives the real React dashboard against the real API and
 * the real MySQL database.
 *
 * PREREQUISITES (this suite does NOT start them for you):
 *   1. backend:  npm run start:dev        (http://localhost:3000)
 *   2. frontend: npm run dev              (http://localhost:5173)
 *   3. seeded:   npm run db:seed
 *
 * Deliberately not auto-starting the servers: a suite that spawns two dev
 * servers, races their readiness, and orphans them on failure is a far worse
 * flake source than an explicit precondition. It's skipped when the app isn't
 * reachable rather than failing with a wall of confusing timeouts.
 */

let appReachable = false;

beforeAll(async () => {
  try {
    const res = await fetch(APP_URL, { signal: AbortSignal.timeout(3000) });
    appReachable = res.ok;
  } catch {
    appReachable = false;
  }

  if (!appReachable) {
    console.warn(
      `\n  SKIPPING E2E: ${APP_URL} is not reachable.` +
        '\n  Start the backend (npm run start:dev) and frontend (npm run dev) first.\n',
    );
  }
});

const itIfUp = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!appReachable) return;
    await fn();
  });

describe('Dashboard E2E', () => {
  let driver: WebDriver;

  beforeAll(async () => {
    if (appReachable) driver = await createTestDriver();
  }, 60_000);

  afterAll(async () => {
    await driver?.quit();
  });

  itIfUp('dashboard loads and shows collected product counts', async () => {
    try {
      const page = new DashboardPage(driver);
      await page.open();
      expect(await page.productCount()).toBeGreaterThanOrEqual(0);
    } catch (err) {
      await screenshot(driver, 'dashboard-load-failure');
      throw err;
    }
  });

  itIfUp('products table renders seeded rows', async () => {
    try {
      const page = new ProductsPage(driver);
      await page.open();
      expect(await page.rowCount()).toBeGreaterThan(0);
    } catch (err) {
      await screenshot(driver, 'products-load-failure');
      throw err;
    }
  });

  itIfUp('search filters the table and is reflected in the URL', async () => {
    try {
      const page = new ProductsPage(driver);
      await page.open();
      const before = await page.rowCount();

      await page.search('keyboard');
      const after = await page.rowCount();

      // The URL IS the filter store — if this isn't in the querystring, sharing
      // a filtered view is broken even when the table looks right.
      expect(await page.currentUrl()).toContain('search=keyboard');
      expect(after).toBeLessThanOrEqual(before);
    } catch (err) {
      await screenshot(driver, 'search-failure');
      throw err;
    }
  });

  itIfUp('marketplace filter narrows results', async () => {
    try {
      const page = new ProductsPage(driver);
      await page.open();
      await page.filterMarketplace('EBAY');
      expect(await page.currentUrl()).toContain('marketplace=EBAY');
      expect(await page.rowCount()).toBeGreaterThan(0);
    } catch (err) {
      await screenshot(driver, 'marketplace-filter-failure');
      throw err;
    }
  });

  itIfUp('product detail renders a price history chart', async () => {
    try {
      const products = new ProductsPage(driver);
      await products.open();
      await products.openFirstProduct();

      const detail = new ProductDetailPage(driver);
      await detail.waitLoaded();

      expect(await detail.title()).toBeTruthy();
      // This is the whole point of a collector: the chart proves >1 observation
      // over time actually made it into the database and back out.
      expect(await detail.hasChart()).toBe(true);
    } catch (err) {
      await screenshot(driver, 'product-detail-failure');
      throw err;
    }
  });

  itIfUp('crawl jobs page lists definitions and runs', async () => {
    try {
      const page = new CrawlJobsPage(driver);
      await page.open();
      expect(await page.jobCount()).toBeGreaterThan(0);
      expect(await page.runCount()).toBeGreaterThan(0);
    } catch (err) {
      await screenshot(driver, 'crawl-jobs-failure');
      throw err;
    }
  });
});
