import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import {
  CrawlJobType,
  Marketplace,
  RunStatus,
  RunTrigger,
} from '../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ICrawlQueue } from './crawl-queue.interface';
import { SchedulerService } from './scheduler.service';

/**
 * The fan-out: one cron fire per marketplace expands into one run per keyword that
 * job tracks. This is where "a list of keywords, daily, on three sites" actually
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
    /** `tracked` marks membership of the job's explicit selection. */
    keywords?: Array<{ id: string; tracked?: boolean }>;
    outstanding?: number;
    trackAllKeywords?: boolean;
  }) {
    const created: Created[] = [];
    const enqueued: string[] = [];
    const trackAll = opts.trackAllKeywords ?? true;

    // Mirrors the real WHERE: the job's selection is the ONLY filter. There used to
    // be a global Keyword.enabled AND-condition here that could veto a job's
    // explicit pick; it's gone, so what a job collects is readable from the job.
    const selected = (opts.keywords ?? []).filter(
      (k) => trackAll || k.tracked === true,
    );

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
        findMany: () =>
          Promise.resolve(created.map((_, i) => ({ id: `run_${i}` }))),
      },
      crawlJob: {
        findUnique: () =>
          Promise.resolve({
            id: 'job_1',
            type: opts.jobType,
            marketplace: Marketplace.AMAZON,
            trackAllKeywords: trackAll,
          }),
      },
      keyword: {
        findMany: () => Promise.resolve(selected.map((k) => ({ id: k.id }))),
      },
    } as unknown as PrismaService;

    const registry = {} as SchedulerRegistry;
    const queue = {
      enqueue: (id: string) => {
        enqueued.push(id);
        return Promise.resolve();
      },
    } as unknown as ICrawlQueue;
    const config = {
      get: (_k: string, d: string) => d,
    } as unknown as ConfigService;

    const service = new SchedulerService(prisma, registry, queue, config);
    const trigger = (
      service as unknown as {
        trigger: (id: string, label: string) => Promise<void>;
      }
    ).trigger.bind(service);

    return { trigger, created, enqueued };
  }

  it('creates one run per keyword, all sharing a batch', async () => {
    const { trigger, created, enqueued } = make({
      jobType: CrawlJobType.KEYWORD_SWEEP,
      keywords: [{ id: 'k1' }, { id: 'k2' }],
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
      keywords: [{ id: 'k1' }],
    });

    await trigger('job_1', 'Amazon sweep');
    await trigger('job_1', 'Amazon sweep');

    expect(new Set(created.map((r) => r.batchId)).size).toBe(2);
  });

  describe('per-job keyword selection', () => {
    /**
     * The default, and why the flag is explicit rather than inferred from an empty
     * join table: "collect everything, including keywords added later" is a real
     * intention that an empty selection cannot express.
     */
    it('collects every keyword when trackAllKeywords is true', async () => {
      const { trigger, created } = make({
        jobType: CrawlJobType.KEYWORD_SWEEP,
        trackAllKeywords: true,
        keywords: [
          { id: 'k1' },
          // Not in the job's selection, and irrelevant — track-all ignores it.
          { id: 'k2', tracked: false },
        ],
      });

      await trigger('job_1', 'Amazon sweep');
      expect(created.map((r) => r.keywordId)).toEqual(['k1', 'k2']);
    });

    it('collects only the selected keywords when trackAllKeywords is false', async () => {
      const { trigger, created } = make({
        jobType: CrawlJobType.KEYWORD_SWEEP,
        trackAllKeywords: false,
        keywords: [
          { id: 'k1', tracked: true },
          { id: 'k2', tracked: false },
          { id: 'k3', tracked: true },
        ],
      });

      await trigger('job_1', 'Amazon sweep');
      expect(created.map((r) => r.keywordId)).toEqual(['k1', 'k3']);
    });

    // A test asserting that a global Keyword.enabled flag could veto a job's
    // explicit selection lived here. That flag is gone: it was a third way to say
    // "don't collect this" (alongside deselecting and deleting), and it made a
    // job's own configuration a lie — you could select a keyword and silently not
    // collect it. What a job collects is now readable from the job alone.

    it('does nothing when the job selects nothing', async () => {
      const { trigger, created, enqueued } = make({
        jobType: CrawlJobType.KEYWORD_SWEEP,
        trackAllKeywords: false,
        keywords: [{ id: 'k1', tracked: false }],
      });

      await trigger('job_1', 'Amazon sweep');
      expect(created).toHaveLength(0);
      expect(enqueued).toHaveLength(0);
    });
  });

  /** An empty keyword list is a config state, not a crash. */
  it('does nothing when there are no keywords at all', async () => {
    const { trigger, created, enqueued } = make({
      jobType: CrawlJobType.KEYWORD_SWEEP,
      keywords: [],
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
      keywords: [{ id: 'k1' }],
      outstanding: 3,
    });

    await trigger('job_1', 'Amazon sweep');

    expect(created).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  /**
   * A PRODUCT_URLS job re-checks a fixed list of URLs and has no search term at
   * all, so it must NOT fan out — one run, no keyword, no batch. It is the only
   * non-sweep type left (SEARCH was removed once Keyword replaced per-job queries).
   */
  it('creates a single keyword-less run for a PRODUCT_URLS job', async () => {
    const { trigger, created, enqueued } = make({
      jobType: CrawlJobType.PRODUCT_URLS,
      keywords: [{ id: 'k1' }],
    });

    await trigger('job_1', 'URL recheck');

    expect(created).toHaveLength(1);
    expect(created[0].keywordId).toBeUndefined();
    expect(created[0].batchId).toBeUndefined();
    expect(enqueued).toHaveLength(1);
  });
});
