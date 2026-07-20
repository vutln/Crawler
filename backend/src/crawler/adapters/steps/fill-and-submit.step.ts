import { By, Key } from 'selenium-webdriver';
import type { StepRuntime } from './step-runtime';

export interface FillAndSubmitConfig {
  /** Selector fallbacks for the input. First one present wins. */
  input: string[];
  value: string;
  /** How the form is submitted. The strategy, plugged in per site. */
  submit: { via: 'enter' } | { via: 'click'; selector: string[] };
  /** Proof the submit landed — usually the result-item selectors. */
  settled: string[];
  /**
   * Assert the page we ended up on is the one we asked for.
   *
   * Not optional in spirit: typing is the failure-prone half of this step and this
   * is what makes it detectable. See the note on the return value.
   */
  expectUrl: (url: string) => boolean;
  timeoutMs?: number;
}

/**
 * Type into a search box and submit it, the way a person does.
 *
 * Returns TRUE when the resulting URL is the one we intended, FALSE when it is
 * not — the caller is expected to fall back to navigating directly. It does not
 * throw on a mismatch, because a mismatch is not an error: it is the site doing
 * something reasonable that we simply cannot use.
 *
 * The URL check is the entire safety net, and typing is not safe without it:
 *
 *   - Amazon's autocomplete overlay is live when Enter fires. Depending on timing
 *     the SUGGESTION wins and "harry potter shirt" silently becomes "harry potter
 *     shirt for women". Every price is valid; the dataset is for another query.
 *   - "Did you mean" corrections quietly search a different term.
 *   - Page-size params have no keyboard equivalent. eBay's `_ipg=60` is a
 *     cross-adapter contract pinned by api-paging.spec.ts; a typed search drops
 *     silently to the site default and that spec keeps passing.
 *   - A typed search has no URL until after it happens, so navigate()'s block
 *     handling has nothing to reload. Confirming the URL gives the caller one it
 *     can re-fetch.
 *
 * Measured 2026-07-20: URL-built and typed searches returned an identical 48 cards
 * on Amazon, the typed one differing only by `&ref=nb_sb_noss`. So typing is
 * equivalent when it works — this step exists to notice when it doesn't.
 */
export async function fillAndSubmit(
  rt: StepRuntime,
  cfg: FillAndSubmitConfig,
): Promise<boolean> {
  const timeoutMs = cfg.timeoutMs ?? 15_000;

  if (!(await rt.waitForAny(cfg.input, timeoutMs))) {
    rt.logger.warn(
      `No search input matching ${cfg.input.join(', ')} — cannot search by typing`,
    );
    return false;
  }

  const box = await rt.driver.findElement(By.css(cfg.input.join(', ')));
  await box.clear();
  await box.sendKeys(cfg.value);

  // Through transition(), so pressing Enter is throttled and block-checked like
  // any other request rather than slipping past both.
  await rt.transition(async () => {
    if (cfg.submit.via === 'enter') {
      await box.sendKeys(Key.RETURN);
    } else if (!(await rt.clickFirst(cfg.submit.selector))) {
      throw new Error(
        `No submit control matching ${cfg.submit.selector.join(', ')}`,
      );
    }
    await rt.waitForAny(cfg.settled, timeoutMs);
  }, `search submit for "${cfg.value}"`);

  const landedOn = await rt.driver.getCurrentUrl();
  if (cfg.expectUrl(landedOn)) return true;

  rt.logger.warn(
    `Typed search landed somewhere unexpected — got ${landedOn.slice(0, 120)}. ` +
      `Falling back to a built URL so the dataset stays the one that was asked for.`,
  );
  return false;
}
