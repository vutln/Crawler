import type { ConfigService } from '@nestjs/config';
import {
  CrawlJobType,
  Marketplace,
  RunStatus,
} from '../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AdapterRegistry } from '../adapters/adapter.registry';
import type {
  CrawlContext,
  MarketplaceAdapter,
  ProductRecord,
} from '../adapters/adapter.interface';
import { CrawlRunnerService } from './crawl-runner.service';

/**
 * The run watchdog.
 *
 * Nothing else bounds a run's total duration. Selenium's own timeouts cover a
 * single page load, so a driver that stops responding BETWEEN loads — or an adapter
 * loop that never terminates — leaves the run RUNNING for as long as the process
 * lives. That is not merely untidy: both trigger paths refuse a job that has an
 * outstanding run, so one hung run disables that job indefinitely, and the queue
 * lane holding it never advances either.
 */
describe('CrawlRunnerService — run timeout', () => {
  /** An adapter whose search() hangs until the signal aborts. */
  function hangingAdapter(): MarketplaceAdapter {
    return {
      marketplace: Marketplace.AMAZON,
      name: 'hanging-test-adapter',
      priority: 10,
      capabilities: { search: true, productDetail: true },
      isAvailable: () => true,
      search: (ctx: CrawlContext): AsyncIterable<ProductRecord> => ({
        // Hand-rolled rather than an async generator: this yields NOTHING by
        // design (a stuck crawl, not a slow one), and a generator with no yield
        // is a lint error for exactly the reason that usually indicates a bug.
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            await new Promise<void>((resolve) => {
              if (ctx.signal.aborted) return resolve();
              ctx.signal.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
            return { done: true as const, value: undefined };
          },
        }),
      }),
      fetchProduct: () => Promise.resolve(null),
    };
  }

  function makeRunner(timeoutMs: number) {
    const updates: Array<Record<string, unknown>> = [];

    const prisma = {
      crawlRun: {
        findUnique: () =>
          Promise.resolve({
            id: 'run_1',
            jobId: 'job_1',
            keywordId: 'kw_1',
            keyword: { id: 'kw_1', text: 'mechanical keyboard' },
            job: {
              id: 'job_1',
              marketplace: Marketplace.AMAZON,
              type: CrawlJobType.KEYWORD_SWEEP,
              urls: null,
              maxPages: 1,
              maxItems: null,
            },
          }),
        update: (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return Promise.resolve({});
        },
      },
    } as unknown as PrismaService;

    const registry = {
      resolve: () => hangingAdapter(),
    } as unknown as AdapterRegistry;

    const config = {
      get: (key: string, fallback?: unknown) =>
        key === 'CRAWL_RUN_TIMEOUT_MS' ? timeoutMs : fallback,
    } as unknown as ConfigService;

    return {
      runner: new CrawlRunnerService(prisma, registry, config),
      /** The status write that ends the run. */
      final: () => updates[updates.length - 1],
    };
  }

  /**
   * THE POINT. Without the watchdog this test never finishes — which is exactly what
   * the job does in production.
   */
  it('aborts a run that exceeds the timeout instead of hanging forever', async () => {
    const { runner, final } = makeRunner(60);

    const outcome = await runner.execute('run_1');

    expect(outcome.status).toBe(RunStatus.FAILED);
    expect(final().status).toBe(RunStatus.FAILED);
    // finishedAt is what releases the job: the outstanding-run check keys off status.
    expect(final().finishedAt).toBeInstanceOf(Date);
  });

  /**
   * A watchdog kill is a FAULT, not a choice. collect() reports CANCELLED for any
   * aborted signal, which is right when a human pressed cancel and wrong here —
   * CANCELLED reads as "somebody stopped this on purpose" and would hide a run that
   * silently wedged for half an hour.
   */
  it('reports it as FAILED with a timeout reason, never CANCELLED', async () => {
    const { runner } = makeRunner(60);

    const outcome = await runner.execute('run_1');

    expect(outcome.status).not.toBe(RunStatus.CANCELLED);
    expect(outcome.error).toMatch(/CRAWL_RUN_TIMEOUT_MS/);
    expect(outcome.error).toMatch(/aborted/i);
  });

  /** A healthy run must not be touched by the watchdog, nor leak its timer. */
  it('leaves a run that finishes in time completely alone', async () => {
    const quick = {
      marketplace: Marketplace.AMAZON,
      name: 'quick-test-adapter',
      priority: 10,
      capabilities: { search: true, productDetail: true },
      isAvailable: () => true,
      // Completes immediately with no records — a healthy, if empty, crawl.
      search: (): AsyncIterable<ProductRecord> => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            Promise.resolve({ done: true as const, value: undefined }),
        }),
      }),
      fetchProduct: () => Promise.resolve(null),
    } as MarketplaceAdapter;

    const updates: Array<Record<string, unknown>> = [];
    const prisma = {
      crawlRun: {
        findUnique: () =>
          Promise.resolve({
            id: 'run_1',
            keyword: { id: 'kw_1', text: 'x' },
            job: {
              id: 'job_1',
              marketplace: Marketplace.AMAZON,
              type: CrawlJobType.KEYWORD_SWEEP,
              urls: null,
              maxPages: 1,
              maxItems: null,
            },
          }),
        update: (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return Promise.resolve({});
        },
      },
    } as unknown as PrismaService;

    const runner = new CrawlRunnerService(
      prisma,
      { resolve: () => quick } as unknown as AdapterRegistry,
      {
        get: (k: string, f?: unknown) =>
          k === 'CRAWL_RUN_TIMEOUT_MS' ? 30_000 : f,
      } as unknown as ConfigService,
    );

    const outcome = await runner.execute('run_1');

    expect(outcome.status).toBe(RunStatus.SUCCEEDED);
    expect(outcome.error).toBeUndefined();
  });
});
