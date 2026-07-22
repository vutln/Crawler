import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { By, until, type WebDriver } from 'selenium-webdriver';

export const APP_URL = process.env.E2E_APP_URL ?? 'http://localhost:5173';

/**
 * Page objects.
 *
 * Every locator is a data-testid, never a CSS class. Classes here are Tailwind
 * utilities that change whenever someone adjusts padding — binding tests to them
 * produces failures that have nothing to do with behaviour.
 */
export abstract class BasePage {
  constructor(protected readonly driver: WebDriver) {}

  protected byTestId(id: string): By {
    return By.css(`[data-testid="${id}"]`);
  }

  /** Waits for presence, not just existence — data arrives async in every view. */
  protected async waitFor(id: string, timeoutMs = 15_000): Promise<void> {
    await this.driver.wait(until.elementLocated(this.byTestId(id)), timeoutMs);
  }

  protected async countOf(id: string): Promise<number> {
    return (await this.driver.findElements(this.byTestId(id))).length;
  }
}

export class DashboardPage extends BasePage {
  async open(): Promise<void> {
    await this.driver.get(APP_URL);
    await this.waitFor('stat-products');
  }

  async productCount(): Promise<number> {
    const el = await this.driver.findElement(this.byTestId('stat-products'));
    return Number((await el.getText()).replace(/,/g, ''));
  }
}

export class ProductsPage extends BasePage {
  async open(): Promise<void> {
    await this.driver.get(`${APP_URL}/products`);
    await this.waitFor('products-table');
  }

  async rowCount(): Promise<number> {
    return this.countOf('product-row');
  }

  async search(term: string): Promise<void> {
    const input = await this.driver.findElement(
      this.byTestId('product-search'),
    );
    await input.clear();
    await input.sendKeys(term);
    // The search box debounces at 300ms; without this the assertion races the
    // request and reads the pre-filter rows.
    await this.driver.sleep(700);
  }

  async filterMarketplace(value: string): Promise<void> {
    const select = await this.driver.findElement(
      this.byTestId('marketplace-filter'),
    );
    await select.findElement(By.css(`option[value="${value}"]`)).click();
    await this.driver.sleep(500);
  }

  async openFirstProduct(): Promise<void> {
    const row = await this.driver.findElement(this.byTestId('product-row'));
    await row.findElement(By.css('a')).click();
    await this.waitFor('product-title');
  }

  async currentUrl(): Promise<string> {
    return this.driver.getCurrentUrl();
  }
}

export class ProductDetailPage extends BasePage {
  async waitLoaded(): Promise<void> {
    await this.waitFor('product-title');
  }

  async title(): Promise<string> {
    return (
      await this.driver.findElement(this.byTestId('product-title'))
    ).getText();
  }

  async hasChart(): Promise<boolean> {
    try {
      await this.waitFor('price-chart', 10_000);
      return true;
    } catch {
      return false;
    }
  }
}

export class CrawlJobsPage extends BasePage {
  async open(): Promise<void> {
    await this.driver.get(`${APP_URL}/crawl-jobs`);
    await this.waitFor('jobs-table');
  }

  async jobCount(): Promise<number> {
    return this.countOf('job-row');
  }

  // runCount() lived here until the runs table moved to its own route — see
  // CrawlRunsPage. A sweep emits one run per keyword per site per day, which is far
  // too much to sit under a three-row job list.
}

/** The keyword list — the feature's input. */
export class KeywordsPage extends BasePage {
  async open(): Promise<void> {
    await this.driver.get(`${APP_URL}/keywords`);
    // Wait for a ROW, not the table shell: the skeleton renders inside the same
    // table, so waiting on 'keywords-table' returns before any data has arrived.
    await this.waitFor('keyword-row');
  }

  async rowCount(): Promise<number> {
    return this.countOf('keyword-row');
  }

  /** Types into the bulk-paste box and returns the live preview summary. */
  async previewPaste(text: string): Promise<string> {
    const box = await this.driver.findElement(this.byTestId('keyword-paste'));
    await box.clear();
    await box.sendKeys(text);
    await this.driver.sleep(300);
    const el = await this.driver.findElement(this.byTestId('keyword-summary'));
    return el.getText();
  }
}

/** Collection history. */
export class CrawlRunsPage extends BasePage {
  async open(query = ''): Promise<void> {
    await this.driver.get(`${APP_URL}/crawl-runs${query}`);
    await this.waitFor('filter-status');
  }

  async rowCount(): Promise<number> {
    return this.countOf('run-row');
  }

  /** The URL is the filter store, so this reads what a shared link would apply. */
  async statusFilter(): Promise<string> {
    const el = await this.driver.findElement(this.byTestId('filter-status'));
    return (await el.getAttribute('value')) ?? '';
  }
}

/**
 * Screenshot on failure. A red E2E test with no artifact is nearly useless —
 * you get "element not found" with no idea what the page actually looked like.
 */
export async function screenshot(
  driver: WebDriver,
  name: string,
): Promise<void> {
  const dir = join(__dirname, '..', '..', 'test-artifacts');
  await mkdir(dir, { recursive: true });
  const png = await driver.takeScreenshot();
  const file = join(dir, `${name}.png`);
  await writeFile(file, png, 'base64');
  console.error(`  screenshot -> ${file}`);
}
