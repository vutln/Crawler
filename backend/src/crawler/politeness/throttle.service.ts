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

  /** hostname -> promise chain tail. Serializes waiters per domain. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly lastRequestAt = new Map<string, number>();
  /** hostname -> consecutive failures, drives exponential backoff. */
  private readonly failures = new Map<string, number>();

  constructor(private readonly config: ConfigService) {
    this.minDelayMs = this.config.get<number>('CRAWL_MIN_DELAY_MS', 2000);
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

  private async waitTurn(host: string, signal?: AbortSignal): Promise<void> {
    const last = this.lastRequestAt.get(host) ?? 0;
    const backoff = this.backoffFor(host);
    const target = last + this.minDelayMs + backoff;
    const waitMs = Math.max(0, target - Date.now());

    if (waitMs > 0) await sleep(waitMs, signal);
    this.lastRequestAt.set(host, Date.now());
  }

  /** Exponential, capped at 60s: 2s, 4s, 8s, 16s... */
  private backoffFor(host: string): number {
    const n = this.failures.get(host) ?? 0;
    if (n === 0) return 0;
    return Math.min(60_000, this.minDelayMs * 2 ** n);
  }

  recordSuccess(url: string): void {
    this.failures.delete(safeHostname(url));
  }

  /** Call on 429/5xx/timeouts. Next acquire() for this host waits longer. */
  recordFailure(url: string): void {
    const host = safeHostname(url);
    const n = (this.failures.get(host) ?? 0) + 1;
    this.failures.set(host, n);
    this.logger.warn(
      `${host}: failure #${n}, backing off ${Math.round(this.backoffFor(host) / 1000)}s`,
    );
  }

  reset(): void {
    this.queues.clear();
    this.lastRequestAt.clear();
    this.failures.clear();
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Abortable sleep — a cancelled run must not sit out a 60s backoff. */
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
