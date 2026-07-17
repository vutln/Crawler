import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Per-domain request pacing.
 *
 * Keyed by hostname, not global: a slow Amazon crawl shouldn't stall an eBay one.
 * Deliberately simple — a serialized minimum-delay gate rather than a token
 * bucket, because bursting is exactly what gets a collector blocked. Steady and
 * boring beats fast and banned.
 */
@Injectable()
export class ThrottleService {
  private readonly logger = new Logger(ThrottleService.name);
  private readonly minDelayMs: number;
  private readonly maxBackoffMs: number;

  /** hostname -> promise chain tail. Serializes waiters per domain. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly lastRequestAt = new Map<string, number>();

  /**
   * hostname -> Crawl-delay the site declared in robots.txt, when it is stricter than
   * our own floor. Only ever holds values above minDelayMs — see setHostFloor.
   */
  private readonly hostFloors = new Map<string, number>();

  /**
   * hostname -> backoff step. Failures nudge it, walls jump it, successes walk it
   * back down one at a time. See recordSuccess for why the walk-down matters.
   */
  private readonly steps = new Map<string, number>();

  /**
   * What a detected wall costs, in steps.
   *
   * A wall is categorically worse than a blip: the site has made a decision about
   * us and it lifts on its own schedule, not ours. At the default 2s floor, +6
   * puts the next request ~2min out (2s * 2^6) and a second wall reaches the cap.
   * A transient 5xx moves a single step, because it usually means nothing.
   */
  private static readonly BLOCK_STEPS = 6;

  constructor(private readonly config: ConfigService) {
    this.minDelayMs = this.config.get<number>('CRAWL_MIN_DELAY_MS', 2000);
    this.maxBackoffMs = this.config.get<number>('CRAWL_MAX_BACKOFF_MS', 900_000);
  }

  /**
   * Resolves when it's polite to hit `url`. Chains onto the domain's queue so
   * concurrent callers line up instead of all firing after the same sleep.
   */
  async acquire(url: string, signal?: AbortSignal): Promise<void> {
    const host = safeHostname(url);
    const previous = this.queues.get(host) ?? Promise.resolve();

    const current = previous.then(() => this.waitTurn(host, signal));
    // Swallow rejections on the chain itself; the caller still sees them via `current`.
    this.queues.set(
      host,
      current.catch(() => undefined),
    );
    return current;
  }

  /** Raw step-based backoff, ignoring time already served. Diagnostics. */
  backoffMsFor(url: string): number {
    return this.backoffFor(safeHostname(url));
  }

  /**
   * Raise this host's pacing floor to a Crawl-delay the site declared in robots.txt.
   * Idempotent — navigate() calls this on every page load.
   *
   * Only ever raises. A site asking for less than CRAWL_MIN_DELAY_MS is not permission
   * to speed up: our floor is a promise we made, not a default the site can bid down.
   */
  setHostFloor(url: string, delayMs: number): void {
    if (delayMs <= this.minDelayMs) return;

    const host = safeHostname(url);
    if (this.hostFloors.get(host) === delayMs) return;

    this.hostFloors.set(host, delayMs);
    this.logger.log(
      `${host}: honouring robots.txt Crawl-delay of ${Math.round(delayMs / 1000)}s ` +
        `(our own floor is ${Math.round(this.minDelayMs / 1000)}s)`,
    );
  }

  /** This host's effective floor: ours, or the site's own if it asked for more. */
  private floorFor(host: string): number {
    return Math.max(this.minDelayMs, this.hostFloors.get(host) ?? 0);
  }

  /**
   * The part of the wait that exists because this host *walled* us, as opposed to the
   * part that is ordinary pacing. Time-aware, so it decays as the cooldown is served.
   *
   * Split from owedMsFor because a caller that refuses to idle a browser through a
   * cooldown must not also refuse to honour a long Crawl-delay. A site asking for 30s
   * between requests is cooperating, and folding that into the same number would read
   * as a block and fail every crawl of a site polite enough to say so.
   */
  owedBackoffMsFor(url: string): number {
    const host = safeHostname(url);
    const last = this.lastRequestAt.get(host) ?? 0;
    return Math.max(0, last + this.backoffFor(host) - Date.now());
  }

  /**
   * Milliseconds still owed before this host may be touched — the backoff minus
   * the time already served. 0 means go now.
   *
   * Time-aware on purpose. Steps only decay on a success, so a cooldown that
   * could *only* be paid off by succeeding would deadlock any caller that
   * declines to knock while owed: no request, no success, no decay, host
   * poisoned for the life of the process. Serving the sentence by waiting has to
   * count.
   */
  owedMsFor(url: string): number {
    return this.owedFor(safeHostname(url));
  }

  private owedFor(host: string): number {
    const last = this.lastRequestAt.get(host) ?? 0;
    const target = last + this.floorFor(host) + this.backoffFor(host);
    return Math.max(0, target - Date.now());
  }

  private async waitTurn(host: string, signal?: AbortSignal): Promise<void> {
    const waitMs = this.owedFor(host);

    // Cooling off after a wall runs to minutes, and the run sits RUNNING for all
    // of it. Announce anything beyond the ordinary floor — an unexplained silent
    // pause is indistinguishable from a hang. Measured against this host's floor
    // rather than ours: where robots.txt asked for 30s, 30s *is* the ordinary pace,
    // and saying so on every page would be noise. setHostFloor announces it once.
    if (waitMs > this.floorFor(host) * 2) {
      this.logger.log(
        `${host}: holding ${Math.round(waitMs / 1000)}s before next request ` +
          `(backoff step ${this.steps.get(host) ?? 0})`,
      );
    }

    if (waitMs > 0) await sleep(waitMs, signal);
    this.lastRequestAt.set(host, Date.now());
  }

  /** Exponential in the step count, capped: 4s, 8s, 16s, 32s, 64s, 128s... */
  private backoffFor(host: string): number {
    const n = this.steps.get(host) ?? 0;
    if (n === 0) return 0;
    return Math.min(this.maxBackoffMs, this.minDelayMs * 2 ** n);
  }

  /**
   * Walk down one step — deliberately not a reset.
   *
   * A full reset made the backoff unreachable in practice. navigate() records a
   * success for every page that loads, so a 3-page search walled on page 3 had
   * its counter wiped by page 1 of the next run: the ceiling was one step (~4s)
   * no matter how often the site refused us.
   *
   * A success is also not evidence the wall is gone. During an Amazon soft block
   * some pages serve normally and others don't, so "it worked once" says nothing
   * about whether we're still being throttled.
   */
  recordSuccess(url: string): void {
    const host = safeHostname(url);
    const n = this.steps.get(host) ?? 0;
    if (n <= 1) this.steps.delete(host);
    else this.steps.set(host, n - 1);
  }

  /** Call on 429/5xx/timeouts. Next acquire() for this host waits a little longer. */
  recordFailure(url: string): void {
    this.bump(url, 1, 'failure');
  }

  /**
   * Call when an anti-bot wall was detected. Distinct from recordFailure on
   * purpose: this is the site telling us to stop, not a blip to shrug off.
   */
  recordBlock(url: string): void {
    this.bump(url, ThrottleService.BLOCK_STEPS, 'BLOCK');
  }

  private bump(url: string, by: number, label: string): void {
    const host = safeHostname(url);
    const n = (this.steps.get(host) ?? 0) + by;
    this.steps.set(host, n);
    this.logger.warn(
      `${host}: ${label} — backoff step ${n}, next request held ` +
        `${Math.round(this.backoffFor(host) / 1000)}s`,
    );
  }

  reset(): void {
    this.queues.clear();
    this.lastRequestAt.clear();
    this.steps.clear();
    this.hostFloors.clear();
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Abortable sleep — a cancelled run must not sit out a 15-minute backoff. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
