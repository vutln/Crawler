import { By } from 'selenium-webdriver';
import type { StepRuntime } from './step-runtime';

/**
 * How a site moves between result pages.
 *
 * `url` is a closure rather than `{ base, param }`: eBay needs `&_pgn=N&_ipg=60`
 * — two params, one of them a page-size contract other adapters depend on — so a
 * param schema would need an escape hatch on its first use. A function is smaller
 * and total. It costs serialisability, which nothing here wants.
 */
export type PaginationConfig =
  | { mode: 'click'; next: string[]; settled: string[] }
  | { mode: 'url'; url: (page: number) => string };

/**
 * Advance to `page`. Returns false when there is demonstrably no next page.
 *
 * The asymmetry between the modes is real and worth keeping rather than papering
 * over: `click` can see that the next-page link is absent or disabled and say so,
 * while `url` can only ever guess, because a URL for page 99 exists whether or not
 * there is anything on it. So `url` always returns true and the caller's own
 * "zero records" check is what terminates the loop.
 */
export async function nextPage(
  rt: StepRuntime,
  cfg: PaginationConfig,
  page: number,
): Promise<boolean> {
  if (cfg.mode === 'url') {
    await rt.navigate(cfg.url(page));
    return true;
  }

  const links = await rt.driver.findElements(By.css(cfg.next.join(', ')));
  if (links.length === 0) {
    // A real signal, and a better one than "the page had no cards": we are on the
    // last page, which is a successful end rather than a suspicious one.
    rt.logger.log(`No next-page link — page ${page - 1} was the last one`);
    return false;
  }

  // Through transition(): a click that loads a page is a request, and must be
  // throttled and block-checked like one.
  await rt.transition(async () => {
    await rt.clickFirst(cfg.next);
    await rt.waitForAny(cfg.settled, 15_000);
  }, `page ${page}`);

  return true;
}
