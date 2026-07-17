import { RunStatus } from '../../generated/prisma/client';
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

/**
 * The queue's job is to drain runs one at a time without letting one bad run take
 * the batch down with it. Fan-out made that sharper: a sweep queues N runs against
 * ONE host, so anything that fails them in bulk destroys a whole day of that
 * marketplace's data.
 */
describe('InMemoryCrawlQueue', () => {
  beforeEach(() => sleepMock.mockClear());

  /** Cooldowns the queue actually waited, in ms. */
  const slept = (): number[] => sleepMock.mock.calls.map((c) => c[0]);

  function makeQueue(outcomes: Record<string, Partial<RunOutcome>> = {}): {
    queue: InMemoryCrawlQueue;
    executed: string[];
  } {
    const executed: string[] = [];

    const runner = {
      execute: (runId: string): Promise<RunOutcome> => {
        executed.push(runId);
        return Promise.resolve({
          status: RunStatus.SUCCEEDED,
          itemsFound: 1,
          itemsNew: 1,
          itemsUpdated: 0,
          ...outcomes[runId],
        });
      },
      cancel: () => true,
    } as unknown as CrawlRunnerService;

    const prisma = {
      crawlRun: { update: () => Promise.resolve({}), updateMany: () => Promise.resolve({}) },
    } as unknown as PrismaService;

    return { queue: new InMemoryCrawlQueue(runner, prisma), executed };
  }

  /** Lets the fire-and-forget drain loop finish before assertions. */
  const settle = () => new Promise((r) => setTimeout(r, 10));

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

  it('drains queued runs in FIFO order', async () => {
    const { queue, executed } = makeQueue();
    void queue.enqueue('a');
    void queue.enqueue('b');
    void queue.enqueue('c');
    await settle();

    expect(executed).toEqual(['a', 'b', 'c']);
  });

  it('keeps draining after a run throws — one bad run cannot strand the queue', async () => {
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

    void queue.enqueue('boom');
    void queue.enqueue('after');
    await settle();

    expect(executed).toEqual(['boom', 'after']);
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
     * it to burn.
     */
    it('holds the queue for the cooldown after a BLOCKED run', async () => {
      const { queue, executed } = makeQueue({
        b: { status: RunStatus.BLOCKED, cooldownMs: 128_000 },
      });

      void queue.enqueue('a');
      void queue.enqueue('b');
      void queue.enqueue('c');
      await settle();

      expect(slept()).toEqual([128_000]);
      // Crucially the run AFTER the block still executes — it is delayed, not lost.
      expect(executed).toEqual(['a', 'b', 'c']);
    });

    it('does not hold on a successful run', async () => {
      const { queue } = makeQueue();
      void queue.enqueue('a');
      void queue.enqueue('b');
      await settle();

      expect(slept()).toEqual([]);
    });

    /** FAILED is a blip, not a wall — the host is owed nothing, so there is nothing to wait out. */
    it('does not hold on a FAILED run', async () => {
      const { queue } = makeQueue({ a: { status: RunStatus.FAILED, error: 'timeout' } });
      void queue.enqueue('a');
      void queue.enqueue('b');
      await settle();

      expect(slept()).toEqual([]);
    });

    /**
     * An API adapter's BlockedError carries no cooldown (there is no throttle host
     * behind it), and waiting an invented amount would be worse than not waiting.
     */
    it('does not hold when the block reports no cooldown', async () => {
      const { queue } = makeQueue({ a: { status: RunStatus.BLOCKED } });
      void queue.enqueue('a');
      void queue.enqueue('b');
      await settle();

      expect(slept()).toEqual([]);
    });

    /** Nothing behind the blocked run — waiting would delay shutdown for no one. */
    it('does not hold when the blocked run was the last one queued', async () => {
      const { queue } = makeQueue({
        a: { status: RunStatus.BLOCKED, cooldownMs: 128_000 },
      });
      void queue.enqueue('a');
      await settle();

      expect(slept()).toEqual([]);
    });
  });
});
