import type { LoggerService } from '@nestjs/common';
import type { WebDriver, WebElement } from 'selenium-webdriver';
import type { CrawlContext } from '../adapter.interface';

/**
 * What a crawl step is allowed to do to a browser.
 *
 * Steps are plain exported functions, not classes and not Nest providers. There is
 * deliberately no `CrawlStep` interface for them to implement: nothing in this
 * codebase iterates a heterogeneous list of steps, and inventing a uniform type
 * would force every step's return value into one shape — `nextPage` answers "was
 * there another page", `enterSession` answers "which door did we come in",
 * `fillAndSubmit` answers "did the search actually land". The moment you hold a
 * `Step[]` you also need `Repeat` and `If` as steps, and the recipe stops being
 * readable TypeScript. The recipe is a method with a `for` loop in it.
 *
 * This type is the one thing they share. SeleniumAdapterBase builds it by closing
 * over `this`, which is what keeps steps free of dependency injection entirely:
 * the five injected services stay on the adapter, populated by Nest exactly as
 * before, and arrive here as bound methods at call time.
 */
export interface StepRuntime {
  readonly driver: WebDriver;
  readonly ctx: CrawlContext;
  readonly logger: LoggerService;

  /**
   * The only sanctioned page load: robots, throttle, block detection, bounded
   * reloads. `probe` marks a page we are trying on spec — the block still throws,
   * but the host is not charged backoff for it.
   */
  navigate(url: string, opts?: { probe?: boolean }): Promise<void>;

  /**
   * A navigation the PAGE performs — pressing Enter, clicking a next-page link.
   *
   * These are real requests that never pass through navigate(), so without this
   * they would skip the throttle floor entirely and a CAPTCHA would only surface
   * later as a confusing "no result containers" diagnosis.
   */
  transition(act: () => Promise<void>, label: string): Promise<void>;

  waitForAny(selectors: string[], timeoutMs?: number): Promise<boolean>;
  /** First selector with a clickable match. False when none can be clicked. */
  clickFirst(selectors: string[]): Promise<boolean>;
  textOf(scope: WebElement, selectors: string[]): Promise<string | undefined>;
  attrOf(
    scope: WebElement,
    selectors: string[],
    attribute: string,
  ): Promise<string | undefined>;
}
