import type { ConfigService } from '@nestjs/config';
import { ThrottleService } from './throttle.service';

/**
 * The backoff is what stands between "we got walled once" and "we kept knocking".
 * These tests assert the step arithmetic directly via backoffMsFor rather than by
 * timing acquire(), so they stay fast and deterministic.
 */
describe('ThrottleService', () => {
  const AMAZON = 'https://www.amazon.com/s?k=tungsten+cube';
  const EBAY = 'https://www.ebay.com/sch/i.html?_nkw=x';

  function makeThrottle(overrides: Record<string, number> = {}): ThrottleService {
    const values: Record<string, number> = {
      CRAWL_MIN_DELAY_MS: 2000,
      CRAWL_MAX_BACKOFF_MS: 900_000,
      ...overrides,
    };
    const config = {
      get: (key: string, fallback?: number) => values[key] ?? fallback,
    } as unknown as ConfigService;
    return new ThrottleService(config);
  }

  let throttle: ThrottleService;

  beforeEach(() => {
    throttle = makeThrottle();
  });

  it('owes nothing on a host it has never seen', () => {
    expect(throttle.backoffMsFor(AMAZON)).toBe(0);
  });

  it('nudges one step on a transient failure: 2s * 2^1', () => {
    throttle.recordFailure(AMAZON);
    expect(throttle.backoffMsFor(AMAZON)).toBe(4000);
  });

  it('jumps six steps on a detected wall — minutes, not seconds', () => {
    throttle.recordBlock(AMAZON);
    // 2000 * 2^6 = 128s. A wall is not a blip; 4s would be knocking again.
    expect(throttle.backoffMsFor(AMAZON)).toBe(128_000);
  });

  it('reaches the cap on a second wall rather than growing unbounded', () => {
    throttle.recordBlock(AMAZON);
    throttle.recordBlock(AMAZON);
    // step 12 -> 2000 * 4096 = 8.2M, clamped.
    expect(throttle.backoffMsFor(AMAZON)).toBe(900_000);
  });

  it('honours a custom cap', () => {
    const tight = makeThrottle({ CRAWL_MAX_BACKOFF_MS: 30_000 });
    tight.recordBlock(AMAZON);
    expect(tight.backoffMsFor(AMAZON)).toBe(30_000);
  });

  describe('decay', () => {
    /**
     * REGRESSION — the backoff was unreachable in practice.
     *
     * recordSuccess used to delete the counter outright. navigate() records a
     * success for every page that loads, so a 3-page search walled on page 3 had
     * its counter wiped by page 1 of the next run. The effective ceiling was one
     * step (~4s) no matter how many times the site refused us, which made both
     * the exponent and the cap decorative.
     */
    it('does not let a single success erase a wall', () => {
      throttle.recordBlock(AMAZON);
      throttle.recordSuccess(AMAZON);

      // One step down (128s -> 64s), not back to zero.
      expect(throttle.backoffMsFor(AMAZON)).toBe(64_000);
    });

    it('walks down one step at a time, and a real crawl cannot outrun a wall', () => {
      throttle.recordBlock(AMAZON); // step 6

      // The exact shape of the old bug: pages 1 and 2 serve, page 3 is walled.
      throttle.recordSuccess(AMAZON); // 5
      throttle.recordSuccess(AMAZON); // 4
      throttle.recordBlock(AMAZON); // 10

      // Net upward. Previously this sat at step 1 forever.
      expect(throttle.backoffMsFor(AMAZON)).toBe(900_000);
    });

    it('does reach zero once the host is consistently healthy', () => {
      throttle.recordFailure(AMAZON);
      throttle.recordSuccess(AMAZON);
      expect(throttle.backoffMsFor(AMAZON)).toBe(0);
    });

    it('is harmless on a host with no recorded trouble', () => {
      throttle.recordSuccess(AMAZON);
      expect(throttle.backoffMsFor(AMAZON)).toBe(0);
    });
  });

  describe('per-domain isolation', () => {
    it('does not let a walled Amazon slow an unrelated eBay', () => {
      throttle.recordBlock(AMAZON);
      expect(throttle.backoffMsFor(EBAY)).toBe(0);
    });

    it('keys on hostname, so a different path on the same host still pays', () => {
      throttle.recordBlock(AMAZON);
      expect(throttle.backoffMsFor('https://www.amazon.com/dp/B0CYY6SFYG')).toBe(128_000);
    });
  });

  describe('owedMsFor — the wait actually remaining', () => {
    it('owes nothing on a host never touched', () => {
      expect(throttle.owedMsFor(AMAZON)).toBe(0);
    });

    it('owes the backoff once a request has been made', async () => {
      await throttle.acquire(AMAZON); // stamps lastRequestAt
      throttle.recordBlock(AMAZON);

      // ~2s floor + 128s backoff, less the moment that just elapsed.
      const owed = throttle.owedMsFor(AMAZON);
      expect(owed).toBeGreaterThan(125_000);
      expect(owed).toBeLessThanOrEqual(130_000);
    });

    /**
     * REGRESSION — a cooldown must be payable by waiting, not only by succeeding.
     *
     * Steps decay solely in recordSuccess. navigate() refuses to knock while
     * heavily owed, so if `owed` were the raw step backoff it would never reach
     * zero: no request -> no success -> no decay -> the host stays poisoned until
     * the process restarts. Time served is what breaks that cycle.
     */
    it('decays with elapsed time even with no successes to spend', async () => {
      const quick = makeThrottle({ CRAWL_MIN_DELAY_MS: 20, CRAWL_MAX_BACKOFF_MS: 1000 });
      await quick.acquire(AMAZON);
      quick.recordBlock(AMAZON); // step 6 -> 20 * 64 = 1280ms, capped to 1000ms

      expect(quick.owedMsFor(AMAZON)).toBeGreaterThan(0);
      expect(quick.backoffMsFor(AMAZON)).toBe(1000); // step count is untouched

      await new Promise((r) => setTimeout(r, 1100));

      // Sentence served purely by waiting; the step count never moved.
      expect(quick.owedMsFor(AMAZON)).toBe(0);
      expect(quick.backoffMsFor(AMAZON)).toBe(1000);
    });
  });

  it('clears everything on reset', () => {
    throttle.recordBlock(AMAZON);
    throttle.reset();
    expect(throttle.backoffMsFor(AMAZON)).toBe(0);
  });

  it('paces an unblocked host at the floor without stalling it', async () => {
    const started = Date.now();
    await throttle.acquire(AMAZON); // first request: nothing owed
    expect(Date.now() - started).toBeLessThan(500);
  });
});
