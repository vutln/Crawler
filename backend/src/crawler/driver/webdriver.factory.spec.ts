import type { ConfigService } from '@nestjs/config';
import type { WebDriver } from 'selenium-webdriver';
import { WebDriverFactory } from './webdriver.factory';

/**
 * The browser LEASE — acquire, always release, never leak.
 *
 * Everything here is about the `finally` actually running. That sounds like a
 * formality until you price the failure: an un-quit driver leaks chrome.exe AND
 * chromedriver.exe on Windows, and the leaked slot is worse — the next caller waits
 * on a promise nothing will ever resolve, so its lane stops forever. Not slowly:
 * forever, until the process restarts and onApplicationBootstrap sweeps the orphans.
 *
 * `withDriverIterable` is the risky one. Its cleanup depends on the consumer's
 * `break` triggering .return() on the generator, which is a language guarantee most
 * people have never had to rely on deliberately — and CrawlRunnerService breaks out
 * of exactly this loop on both maxItems and abort.
 */
describe('WebDriverFactory — lease lifecycle', () => {
  /**
   * Replaces the two things that touch a real browser, so the lease logic can be
   * tested without launching Chrome. Everything else is the real class.
   */
  function makeFactory(maxDrivers = 1) {
    const config = {
      get: (key: string, fallback?: unknown) =>
        key === 'SELENIUM_MAX_DRIVERS' ? maxDrivers : fallback,
    } as unknown as ConfigService;

    const factory = new WebDriverFactory(config);
    const created: WebDriver[] = [];
    const quit: WebDriver[] = [];

    Object.assign(factory, {
      create: () => {
        const driver = { id: created.length } as unknown as WebDriver;
        created.push(driver);
        return Promise.resolve(driver);
      },
      quit: (d: WebDriver) => {
        quit.push(d);
        return Promise.resolve();
      },
    });

    return {
      factory,
      created: () => created.length,
      quit: () => quit.length,
      /** Slots currently held. Non-zero after everything settles means a leak. */
      leased: () => (factory as unknown as { leased: number }).leased,
    };
  }

  describe('withDriverIterable', () => {
    it('quits the driver when the consumer breaks early', async () => {
      const f = makeFactory();

      // Async generators with no await are the norm in this file: the factory takes
      // an AsyncIterable, and what these bodies model is yielding, not awaiting.
      // eslint-disable-next-line @typescript-eslint/require-await
      for await (const n of f.factory.withDriverIterable(async function* () {
        yield 1;
        yield 2;
        yield 3;
      })) {
        void n;
        break; // exactly what CrawlRunnerService does on maxItems
      }

      expect(f.created()).toBe(1);
      expect(f.quit()).toBe(1);
      expect(f.leased()).toBe(0);
    });

    it('quits the driver when the body throws', async () => {
      const f = makeFactory();

      await expect(
        (async () => {
          for await (const n of f.factory.withDriverIterable(
            // eslint-disable-next-line @typescript-eslint/require-await
            async function* () {
              yield 1;
              throw new Error('blocked on page 2');
            },
          )) {
            void n;
          }
        })(),
      ).rejects.toThrow('blocked on page 2');

      expect(f.quit()).toBe(1);
      expect(f.leased()).toBe(0);
    });

    it('quits the driver on normal completion', async () => {
      const f = makeFactory();

      const seen: number[] = [];
      // eslint-disable-next-line @typescript-eslint/require-await
      for await (const n of f.factory.withDriverIterable(async function* () {
        yield 1;
        yield 2;
      })) {
        seen.push(n);
      }

      expect(seen).toEqual([1, 2]);
      expect(f.quit()).toBe(1);
      expect(f.leased()).toBe(0);
    });

    /**
     * The whole point of streaming: the consumer sees a value while the producer is
     * still mid-flight, so a later failure cannot retroactively discard it.
     */
    it('hands each value over before producing the next', async () => {
      const f = makeFactory();
      const produced: number[] = [];
      const consumed: number[] = [];

      // eslint-disable-next-line @typescript-eslint/require-await
      for await (const n of f.factory.withDriverIterable(async function* () {
        for (const v of [1, 2, 3]) {
          produced.push(v);
          yield v;
        }
      })) {
        consumed.push(n);
        // At this instant the producer must not have run ahead.
        expect(produced.length).toBe(consumed.length);
      }
    });

    /** A lease is only taken when someone actually pulls — building it is free. */
    it('does not take a slot until iteration starts', async () => {
      const f = makeFactory();

      // eslint-disable-next-line @typescript-eslint/require-await
      const it = f.factory.withDriverIterable(async function* () {
        yield 1;
      });

      expect(f.created()).toBe(0);
      expect(f.leased()).toBe(0);

      for await (const n of it) {
        void n;
      }
      expect(f.created()).toBe(1);
    });
  });

  describe('slot starvation', () => {
    /**
     * THE HANG THIS PREVENTS. With a lease held for a whole run, a starved caller
     * used to wait on a bare Promise with no way out — so the run watchdog's
     * abort() did nothing and the lane stopped permanently.
     */
    it('a waiting caller can be aborted', async () => {
      const f = makeFactory(1);
      const controller = new AbortController();

      // Hold the only slot open.
      let releaseFirst!: () => void;
      const firstDone = f.factory.withDriver(
        () => new Promise<void>((r) => (releaseFirst = r)),
      );

      // Second caller queues behind it, then gives up.
      const second = f.factory.withDriver(
        () => Promise.resolve(),
        controller.signal,
      );
      const settled = expect(second).rejects.toThrow(/abort/i);
      controller.abort();
      await settled;

      releaseFirst();
      await firstDone;

      // The abandoned waiter must not still be holding a claim on the pool.
      expect(f.leased()).toBe(0);
    });

    /** An already-aborted caller never queues at all. */
    it('refuses immediately when the signal is already aborted', async () => {
      const f = makeFactory(1);
      const controller = new AbortController();
      controller.abort();

      await expect(
        f.factory.withDriver(() => Promise.resolve(), controller.signal),
      ).rejects.toThrow(/abort/i);

      expect(f.created()).toBe(0);
      expect(f.leased()).toBe(0);
    });

    /**
     * An aborted waiter must be spliced out of the queue, not merely rejected —
     * otherwise releaseSlot later hands a browser to someone who walked away, and
     * that slot is gone for good.
     */
    it('an aborted waiter does not consume the slot it was waiting for', async () => {
      const f = makeFactory(1);
      const controller = new AbortController();

      let releaseFirst!: () => void;
      const firstDone = f.factory.withDriver(
        () => new Promise<void>((r) => (releaseFirst = r)),
      );

      const abandoned = f.factory.withDriver(
        () => Promise.resolve(),
        controller.signal,
      );
      const abandonedSettled = expect(abandoned).rejects.toThrow(/abort/i);

      // A third caller queues behind the one that is about to give up.
      let thirdRan = false;
      const third = f.factory.withDriver(() => {
        thirdRan = true;
        return Promise.resolve();
      });

      controller.abort();
      await abandonedSettled;

      releaseFirst();
      await firstDone;
      await third;

      expect(thirdRan).toBe(true); // it got the slot the abandoned waiter freed
      expect(f.leased()).toBe(0);
    });
  });
});
