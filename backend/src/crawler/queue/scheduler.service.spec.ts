import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import { CrawlJobType, Marketplace, RunStatus, RunTrigger } from '../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ICrawlQueue } from './crawl-queue.interface';
import { SchedulerService } from './scheduler.service';

/**
 * The fan-out: one cron fire per marketplace expands into one run per enabled
 * keyword. This is where "a list of keywords, daily, on three sites" actually
 * happens, and it is the reason adding a keyword touches no cron registration.
 */
describe('SchedulerService — KEYWORD_SWEEP fan-out', () => {
  interface Created {
    jobId: string;
    keywordId?: string;
    batchId?: string;
    status: RunStatus;
    trigger: RunTrigger;
  }

  function make(opts: {
    jobType: CrawlJobType;
    keywords?: Array<{ id: string; enabled: boolean }>;
    outstanding?: number;
  }) {
    const created: Created[] = [];
    const enqueued: string[] = [];
    const enabled = (opts.keywords ?? []).filter((k) => k.enabled);

    const prisma = {
      crawlRun: {
        count: () => Promise.resolve(opts.outstanding ?? 0),
        create: ({ data }: { data: Created }) => {
          created.push(data);
          return Promise.resolve({ id: `run_${created.length}` });
        },
        createMany: ({ data }: { data: Created[] }) => {
          created.push(...data);
          return Promise.resolve({ count: data.length });
        },
        findMany: () => Promise.resolve(created.map((_, i) => ({ id: `run_${i}` }))),
      },
      crawlJob: {
        findUnique: () =>
          Promise.resolve({ id: 'job_1', type: opts.jobType, marketplace: Marketplace.AMAZON }),
      },
      keyword: { findMany: () => Promise.resolve(enabled.map((k) => ({ id: k.id }))) },
    } as unknown as PrismaService;

    const registry = {} as SchedulerRegistry;
    const queue = {
      enqueue: (id: string) => {
        enqueued.push(id);
        return Promise.resolve();
      },
    } as unknown as ICrawlQueue;
    const config = { get: (_k: string, d: string) => d } as unknown as ConfigService;

    const service = new SchedulerService(prisma, registry, queue, config);
    const trigger = (service as unknown as { trigger: (id: string, label: string) => Promise<void> })
      .trigger.bind(service);

    return { trigger, created, enqueued };
  }

  it('creates one run per ENABLED keyword, all sharing a batch', async () => {
    const { trigger, created, enqueued } = make({
      jobType: CrawlJobType.KEYWORD_SWEEP,
      keywords: [
        { id: 'k1', enabled: true },
        { id: 'k2', enabled: true },
        // Disabled keywords stay in the list but are skipped — that is what the
        // enabled flag is for, and why disabling beats deleting.
        { id: 'k3', enabled: false },
      ],
    });

    await trigger('job_1', 'Amazon sweep');

    expect(created).toHaveLength(2);
    expect(created.map((r) => r.keywordId)).toEqual(['k1', 'k2']);

    // One batch id across the whole fire: this is what lets the history screen say
    // "Amazon sweep, 19/20 succeeded" instead of listing 20 unrelated rows.
    const batches = new Set(created.map((r) => r.batchId));
    expect(batches.size).toBe(1);
    expect([...batches][0]).toBeTruthy();

    expect(created.every((r) => r.status === RunStatus.QUEUED)).toBe(true);
    expect(created.every((r) => r.trigger === RunTrigger.SCHEDULED)).toBe(true);
    expect(enqueued).toHaveLength(2);
  });

  it('gives each fire its own batch id', async () => {
    const { trigger, created } = make({
      jobType: CrawlJobType.KEYWORD_SWEEP,
      keywords: [{ id: 'k1', enabled: true }],
    });

    await trigger('job_1', 'Amazon sweep');
    await trigger('job_1', 'Amazon sweep');

    expect(new Set(created.map((r) => r.batchId)).size).toBe(2);
  });

  /** An empty keyword list is a config state, not a crash. */
  it('does nothing when no keywords are enabled', async () => {
    const { trigger, created, enqueued } = make({
      jobType: CrawlJobType.KEYWORD_SWEEP,
      keywords: [{ id: 'k1', enabled: false }],
    });

    await trigger('job_1', 'Amazon sweep');

    expect(created).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  /**
   * The outstanding-run guard is why the sweep job stays per-marketplace: all N of
   * yesterday's keyword runs share this jobId, so an unfinished Amazon sweep
   * suppresses today's Amazon fire while eBay — a different job — is unaffected.
   */
  it('skips the whole fire when the previous sweep is still running', async () => {
    const { trigger, created, enqueued } = make({
      jobType: CrawlJobType.KEYWORD_SWEEP,
      keywords: [{ id: 'k1', enabled: true }],
      outstanding: 3,
    });

    await trigger('job_1', 'Amazon sweep');

    expect(created).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  /** Legacy jobs must keep working untouched — one run, no keyword, no batch. */
  it('creates a single keyword-less run for a plain SEARCH job', async () => {
    const { trigger, created, enqueued } = make({
      jobType: CrawlJobType.SEARCH,
      keywords: [{ id: 'k1', enabled: true }],
    });

    await trigger('job_1', 'Legacy search');

    expect(created).toHaveLength(1);
    expect(created[0].keywordId).toBeUndefined();
    expect(created[0].batchId).toBeUndefined();
    expect(enqueued).toHaveLength(1);
  });
});
