import { BlockedError } from '../adapter.interface';
import type { StepRuntime } from './step-runtime';

export interface EntryConfig {
  /**
   * Homepage to try first. Omit to skip the probe entirely and go straight to
   * `fallbackUrl` — which is how a site whose homepage is reliably hostile gets
   * opted out without touching this step.
   */
  homepage?: string;
  /** Proof the homepage rendered as itself. Usually the search box. */
  ready: string[];
  /** Where to go when the homepage is unusable. Must be a real crawl target. */
  fallbackUrl: string;
  readyTimeoutMs?: number;
}

export interface Entry {
  via: 'homepage' | 'direct';
  /** The URL now loaded — callers thread this into steps that reload the page. */
  url: string;
}

/**
 * Open a browsing session, preferring the front door.
 *
 * Starting at the homepage and searching from there is how a person arrives, and
 * it earns the session its cookies and a referrer chain before any search happens.
 * But the front door is not always open: measured 2026-07-20, amazon.com/ returned
 * a 2KB AWS WAF page with no nav while a search URL returned 1.7MB of results in
 * the same browser seconds apart. So the homepage is a PREFERENCE, never a
 * requirement, and failing to get in is not failing the crawl.
 *
 * Two ways the homepage can be unusable, and both fall back:
 *   - navigate() throws BlockedError (a detected wall)
 *   - it loads, but `ready` never appears — a WAF challenge the detector does not
 *     recognise renders a page with no nav at all, and looks like success
 */
export async function enterSession(
  rt: StepRuntime,
  cfg: EntryConfig,
): Promise<Entry> {
  if (cfg.homepage) {
    let landed = true;

    try {
      /**
       * probe: a wall here must not charge the host backoff.
       *
       * Throttle state is keyed by hostname, so the homepage and the search page
       * share one bucket. Charging a block would owe ~128s on that host and the
       * fallback navigate() below would then refuse to knock at all — the fallback
       * could never run, on precisely the intermittent WAF it exists to survive.
       */
      await rt.navigate(cfg.homepage, { probe: true });
    } catch (err) {
      // A wall is a reason to use the other door, not to fail. Anything else —
      // robots disallow, a driver fault — is a real error and propagates.
      if (!(err instanceof BlockedError)) throw err;
      landed = false;
    }

    if (
      landed &&
      (await rt.waitForAny(cfg.ready, cfg.readyTimeoutMs ?? 10_000))
    ) {
      return { via: 'homepage', url: cfg.homepage };
    }

    rt.logger.warn(
      `Homepage gave no usable nav — entering at ${cfg.fallbackUrl} instead. ` +
        `The crawl is unaffected; only the organic entry path is skipped.`,
    );
  }

  // No probe flag: a wall on the page we actually want IS evidence, and must cost
  // the host its backoff like any other block.
  await rt.navigate(cfg.fallbackUrl);
  return { via: 'direct', url: cfg.fallbackUrl };
}
