import { Marketplace, RunStatus } from '../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CrawlRunnerService, RunOutcome } from '../pipeline/crawl-runner.service';
import { sleep } from '../politeness/throttle.service';
import { InMemoryCrawlQueue } from './in-memory-crawl.queue';

/**
 * Stub only `sleep`, keeping the real ThrottleService — the queue's own coolDown()
 * then runs for real, guards and all, without the suite waiting 128 seconds.
 *
 * Wrapping coolDown() instead would have been wrong: it records the call BEFORE
 * the method's own "is anything queued behind it" guard runs, so the skip cases
 * would look like holds.
 */
jest.mock('../politeness/throttle.service', () => ({
  ...jest.requireActual<object>('../politeness/throttle.service'),
  sleep: jest.fn().mockResolvedValue(undefined),
}));

const sleepMock = sleep as jest.MockedFunction<typeof sleep>;

const AMAZON = Marketplace.AMAZON;
const EBAY = Marketplace.EBAY;
const ETSY = Marketplace.ETSY;

/**
 * The queue drains runs one at a time PER MARKETPLACE, and marketplaces
 * concurrently. Fan-out made the first half matter: a sweep queues N runs against
 * ONE host, so anything that fails them in bulk destroys a day of that
 * marketplace's data. Lanes made the second half matter: before them, one Amazon
 * wall held the only lane and eBay's whole day waited behind it.
 */
describe('InMemoryCrawlQueue', () => {
  beforeEach(() => {
    sleepMock.mockClear();
    sleepMock.mockResolvedValue(undefined);
  });

  /** Cooldowns the queue actually waited, in ms. */
  const slept = (): number[] => sleepMock.mock.calls.map((c) => c[0]);

  function makeQueue(
    outcomes: Record<string, Partial<RunOutcome>> = {},
    /**
     * Run ids whose execute() hangs until released — for observing concurrency.
     * Optional-valued: a lookup miss is `undefined`, and typing it otherwise makes
     * the guard below look dead to the compiler.
     */
    hold: Record<string, Promise<void> | undefined> = {},
  ): { queue: InMemoryCrawlQueue; executed: string[]; cancelled: string[] } {
    const executed: string[] = [];
    const cancelled: string[] = [];

    const runner = {
      execute: async (runId: string): Promise<RunOutcome> => {
        executed.push(runId);
        if (hold[runId]) await hold[runId];
        return {
          status: RunStatus.SUCCEEDED,
          itemsFound: 1,
          itemsNew: 1,
          itemsUpdated: 0,
          ...outcomes[runId],
        };
      },
      cancel: (runId: string) => {
        cancelled.push(runId);
        return true;
      },
    } as unknown as CrawlRunnerService;

    const prisma = {
      crawlRun: { update: () => Promise.resolve({}), updateMany: () => Promise.resolve({}) },
    } as unknown as PrismaService;

    return {
      queue: new InMemoryCrawlQueue(runner, prisma),
      executed,
      cancelled,
    };
  }

  /** Lets the fire-and-forget drain loops finish before assertions. */
  const settle = () => new Promise((r) => setTimeout(r, 10));

  /** A promise plus its resolver, for holding a run or a cooldown open. */
  function deferred(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    return { promise, release };
  }

  /**
   * NOTE: the enqueues below are `void`, never `await`ed, and that is load-bearing.
   *
   * enqueue() is synchronous up to `void this.drain()`, and drain() runs until its
   * first `await runner.execute()`. So calling enqueue three times in a row leaves
   * all three queued. AWAITING each one instead yields to the microtask queue, the
   * drain loop finishes that single run and exits with an empty queue, and the next
   * enqueue starts a fresh loop — meaning only ONE run is ever pending, coolDown's
   * "is anything queued behind it" guard always fires, and the cascade tests pass
   * for entirely the wrong reason.
   */

  it('drains a marketplace’s runs in FIFO order', async () => {
    const { queue, executed } = makeQueue();
    void queue.enqueue('a', AMAZON);
    void queue.enqueue('b', AMAZON);
    void queue.enqueue('c', AMAZON);
    await settle();

    expect(executed).toEqual(['a', 'b', 'c']);
  });

  it('keeps draining after a run throws — one bad run cannot strand the lane', async () => {
    const executed: string[] = [];
    const runner = {
      execute: (runId: string) => {
        executed.push(runId);
        if (runId === 'boom') return Promise.reject(new Error('runner bug'));
        return Promise.resolve({ status: RunStatus.SUCCEEDED, itemsFound: 0, itemsNew: 0, itemsUpdated: 0 });
      },
      cancel: () => true,
    } as unknown as CrawlRunnerService;
    const prisma = {
      crawlRun: { update: () => Promise.resolve({}), updateMany: () => Promise.resolve({}) },
    } as unknown as PrismaService;
    const queue = new InMemoryCrawlQueue(runner, prisma);

    void queue.enqueue('boom', AMAZON);
    void queue.enqueue('after', AMAZON);
    await settle();

    expect(executed).toEqual(['boom', 'after']);
  });

  /**
   * THE REASON LANES EXIST.
   *
   * Verified by mutation, not by assertion: collapsing laneFor() to a single shared
   * key reproduces the old queue exactly, and these fail against it —
   *
   *   - runs different marketplaces concurrently
   *   - a wall on one marketplace does not delay another
   *   - counts queued runs across every lane
   *   - (block cascade) does not hold when only another marketplace has runs queued
   *
   * The rest of this block passes either way, and is here as a regression guard on
   * the refactor rather than as evidence of it: serialization WITHIN a lane is the
   * politeness property lanes must not break, and cancel/shutdown had to grow from
   * "the one active run" to "search every lane" without losing anything.
   */
  describe('lane isolation', () => {
    /** A slow Amazon run must not stop eBay from starting. */
    it('runs different marketplaces concurrently', async () => {
      const amazonRun = deferred();
      const { queue, executed } = makeQueue({}, { 'amz-1': amazonRun.promise });

      void queue.enqueue('amz-1', AMAZON);
      void queue.enqueue('ebay-1', EBAY);
      void queue.enqueue('etsy-1', ETSY);
      await settle();

      // amz-1 is still in flight, yet the other two have already run.
      expect(executed).toEqual(['amz-1', 'ebay-1', 'etsy-1']);
      expect(queue.isBusy()).toBe(true);

      amazonRun.release();
      await settle();
    });

    /** Within a lane, serialization still holds — that is the politeness guarantee. */
    it('still serializes within one marketplace', async () => {
      const first = deferred();
      const { queue, executed } = makeQueue({}, { 'amz-1': first.promise });

      void queue.enqueue('amz-1', AMAZON);
      void queue.enqueue('amz-2', AMAZON);
      await settle();

      // amz-2 must NOT have started while amz-1 is in flight.
      expect(executed).toEqual(['amz-1']);

      first.release();
      await settle();
      expect(executed).toEqual(['amz-1', 'amz-2']);
    });

    /**
     * THE HEADLINE. Amazon walls, its lane sits out the cooldown, and eBay runs
     * during it. On a single-lane queue eBay would be stuck behind that sleep.
     */
    it('a wall on one marketplace does not delay another', async () => {
      const cooldown = deferred();
      // Hold the cooldown open so "during the wait" is observable.
      sleepMock.mockImplementationOnce(() => cooldown.promise);

      const { queue, executed } = makeQueue({
        'amz-1': { status: RunStatus.BLOCKED, cooldownMs: 128_000 },
      });

      void queue.enqueue('amz-1', AMAZON);
      void queue.enqueue('amz-2', AMAZON);
      void queue.enqueue('ebay-1', EBAY);
      await settle();

      expect(slept()).toEqual([128_000]);
      // Amazon's next run is correctly held...
      expect(executed).not.toContain('amz-2');
      // ...while eBay ran straight through the wall it has nothing to do with.
      expect(executed).toContain('ebay-1');

      cooldown.release();
      await settle();
      expect(executed).toContain('amz-2'); // delayed, never lost
    });

    it('counts queued runs across every lane', async () => {
      const held = deferred();
      const { queue } = makeQueue(
        {},
        { 'amz-1': held.promise, 'ebay-1': held.promise },
      );

      void queue.enqueue('amz-1', AMAZON);
      void queue.enqueue('amz-2', AMAZON);
      void queue.enqueue('ebay-1', EBAY);
      void queue.enqueue('ebay-2', EBAY);
      await settle();

      // One in flight per lane, one still pending in each.
      expect(queue.size()).toBe(2);

      held.release();
      await settle();
      expect(queue.size()).toBe(0);
    });

    /** cancel() has to search every lane now, not just the one active run. */
    it('cancels a queued run in whichever lane holds it', async () => {
      const held = deferred();
      // ebay-1 must be the held one: it is what keeps ebay-2 QUEUED long enough to
      // be cancellable. Holding only amz-1 would let the eBay lane drain completely
      // and the test would pass or fail for reasons unrelated to lane lookup.
      const { queue, executed } = makeQueue({}, { 'ebay-1': held.promise });

      void queue.enqueue('amz-1', AMAZON);
      void queue.enqueue('ebay-1', EBAY);
      void queue.enqueue('ebay-2', EBAY);
      await settle();

      // ebay-2 is queued behind ebay-1 in the eBay lane.
      await expect(queue.cancel('ebay-2')).resolves.toBe(true);
      await expect(queue.cancel('nope')).resolves.toBe(false);

      held.release();
      await settle();
      expect(executed).not.toContain('ebay-2');
    });

    /** Shutdown must sweep every lane, not just whichever one drained last. */
    it('marks orphans across all lanes on shutdown', async () => {
      const held = deferred();
      // Typed rather than cast: the assertion below reads calls[0][0] several
      // levels deep, and on a bare jest.fn() that whole path is `any`.
      type OrphanUpdate = { where: { id: { in: string[] } } };
      const updateMany = jest
        .fn<Promise<unknown>, [OrphanUpdate]>()
        .mockResolvedValue({});

      const runner = {
        execute: async (runId: string) => {
          if (runId === 'amz-1') await held.promise;
          return {
            status: RunStatus.SUCCEEDED,
            itemsFound: 0,
            itemsNew: 0,
            itemsUpdated: 0,
          };
        },
        cancel: () => true,
      } as unknown as CrawlRunnerService;
      const prisma = {
        crawlRun: { update: () => Promise.resolve({}), updateMany },
      } as unknown as PrismaService;
      const queue = new InMemoryCrawlQueue(runner, prisma);

      void queue.enqueue('amz-1', AMAZON);
      void queue.enqueue('amz-2', AMAZON);
      void queue.enqueue('ebay-1', EBAY);
      await settle();

      await queue.onModuleDestroy();

      const orphans = updateMany.mock.calls[0][0].where.id.in;
      // The active Amazon run and the one queued behind it. eBay's already finished.
      expect(orphans).toEqual(expect.arrayContaining(['amz-1', 'amz-2']));

      held.release();
    });
  });

  /**
   * Recovery from a shutdown that skipped onModuleDestroy.
   *
   * onModuleDestroy handles the graceful case, but it is a lifecycle hook — it does
   * not run for SIGKILL, `taskkill /F`, an OOM kill, a crash, or a power cut. Those
   * leave rows saying RUNNING with no process behind them, and because BOTH trigger
   * paths refuse a job that has an outstanding run, one hard kill disables that job
   * permanently. Nothing expires it; the only other cure is editing the database.
   */
  describe('startup recovery', () => {
    /** Typed so the deep assertions below are not reads off `any`. */
    type RecoverArgs = {
      where: { status: { in: RunStatus[] } };
      data: { status: RunStatus; finishedAt: Date; error: string };
    };
    type RecoverMock = jest.Mock<Promise<{ count: number }>, [RecoverArgs]>;

    function makeQueueWithPrisma(updateMany: RecoverMock) {
      const runner = {
        execute: () =>
          Promise.resolve({
            status: RunStatus.SUCCEEDED,
            itemsFound: 0,
            itemsNew: 0,
            itemsUpdated: 0,
          }),
        cancel: () => true,
      } as unknown as CrawlRunnerService;
      const prisma = {
        crawlRun: { update: () => Promise.resolve({}), updateMany },
      } as unknown as PrismaService;
      return new InMemoryCrawlQueue(runner, prisma);
    }

    it('fails runs left QUEUED or RUNNING by a previous process', async () => {
      const updateMany = jest
        .fn<Promise<{ count: number }>, [RecoverArgs]>()
        .mockResolvedValue({ count: 3 });
      const queue = makeQueueWithPrisma(updateMany);

      await queue.onApplicationBootstrap();

      expect(updateMany).toHaveBeenCalledTimes(1);
      const arg = updateMany.mock.calls[0][0];

      // Exactly the two states that block a job from being triggered again.
      expect(arg.where.status.in).toEqual([
        RunStatus.QUEUED,
        RunStatus.RUNNING,
      ]);
      expect(arg.data.status).toBe(RunStatus.FAILED);
      // Says WHY, so a recovered row does not read as a crawl fault.
      expect(arg.data.error).toMatch(
        /Server stopped before this run finished/i,
      );
      expect(arg.data.finishedAt).toBeInstanceOf(Date);
    });

    /**
     * FAILED, not re-queued. A dead run may already have written products, so
     * silently re-running it is not obviously safe — and a status that lies is worse
     * than one that admits failure.
     */
    it('does not re-queue what it recovers', async () => {
      const updateMany = jest
        .fn<Promise<{ count: number }>, [RecoverArgs]>()
        .mockResolvedValue({ count: 2 });
      const queue = makeQueueWithPrisma(updateMany);

      await queue.onApplicationBootstrap();
      await settle();

      expect(queue.size()).toBe(0);
      expect(queue.isBusy()).toBe(false);
    });

    /** The overwhelmingly common case: a clean previous shutdown, nothing to do. */
    it('is silent when there is nothing to recover', async () => {
      const updateMany = jest
        .fn<Promise<{ count: number }>, [RecoverArgs]>()
        .mockResolvedValue({ count: 0 });
      const queue = makeQueueWithPrisma(updateMany);

      await expect(queue.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });

  describe('block cascade', () => {
    /**
     * THE REGRESSION FAN-OUT INTRODUCES.
     *
     * A wall costs the host ~128s of backoff. During it, navigate() refuses to
     * knock and fails in MILLISECONDS — so failing fast is far quicker than the
     * cooldown, and with 20 keyword runs queued against one marketplace, a block on
     * run 5 would burn runs 6..20 in a couple of seconds and mark every one BLOCKED.
     * A whole day of that marketplace's data destroyed by a single wall.
     *
     * This did not exist before: one job meant one run, so there was nothing behind
     * it to burn. Lanes do not change it — within a marketplace the cascade is
     * exactly as dangerous, which is why this whole block still applies per lane.
     */
    it('holds the lane for the cooldown after a BLOCKED run', async () => {
      const { queue, executed } = makeQueue({
        b: { status: RunStatus.BLOCKED, cooldownMs: 128_000 },
      });

      void queue.enqueue('a', AMAZON);
      void queue.enqueue('b', AMAZON);
      void queue.enqueue('c', AMAZON);
      await settle();

      expect(slept()).toEqual([128_000]);
      // Crucially the run AFTER the block still executes — it is delayed, not lost.
      expect(executed).toEqual(['a', 'b', 'c']);
    });

    it('does not hold on a successful run', async () => {
      const { queue } = makeQueue();
      void queue.enqueue('a', AMAZON);
      void queue.enqueue('b', AMAZON);
      await settle();

      expect(slept()).toEqual([]);
    });

    /** FAILED is a blip, not a wall — the host is owed nothing, so there is nothing to wait out. */
    it('does not hold on a FAILED run', async () => {
      const { queue } = makeQueue({ a: { status: RunStatus.FAILED, error: 'timeout' } });
      void queue.enqueue('a', AMAZON);
      void queue.enqueue('b', AMAZON);
      await settle();

      expect(slept()).toEqual([]);
    });

    /**
     * An API adapter's BlockedError carries no cooldown (there is no throttle host
     * behind it), and waiting an invented amount would be worse than not waiting.
     */
    it('does not hold when the block reports no cooldown', async () => {
      const { queue } = makeQueue({ a: { status: RunStatus.BLOCKED } });
      void queue.enqueue('a', AMAZON);
      void queue.enqueue('b', AMAZON);
      await settle();

      expect(slept()).toEqual([]);
    });

    /** Nothing behind the blocked run IN ITS LANE — waiting would delay shutdown for no one. */
    it('does not hold when the blocked run was the last one queued for that marketplace', async () => {
      const { queue } = makeQueue({
        a: { status: RunStatus.BLOCKED, cooldownMs: 128_000 },
      });
      void queue.enqueue('a', AMAZON);
      await settle();

      expect(slept()).toEqual([]);
    });

    /**
     * The guard is per-lane, so a run queued for a DIFFERENT marketplace must not
     * make Amazon's lane wait. Reading queue depth globally would do exactly that.
     */
    it('does not hold when only another marketplace has runs queued behind it', async () => {
      const held = deferred();
      const { queue } = makeQueue(
        { 'amz-1': { status: RunStatus.BLOCKED, cooldownMs: 128_000 } },
        { 'ebay-1': held.promise },
      );

      void queue.enqueue('amz-1', AMAZON);
      void queue.enqueue('ebay-1', EBAY);
      void queue.enqueue('ebay-2', EBAY);
      await settle();

      expect(slept()).toEqual([]);

      held.release();
      await settle();
    });
  });
});
