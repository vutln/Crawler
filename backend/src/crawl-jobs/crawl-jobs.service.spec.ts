import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  CrawlJobType,
  Marketplace,
  RunTrigger,
} from '../generated/prisma/client';
import type { AdapterRegistry } from '../crawler/adapters/adapter.registry';
import type { ICrawlQueue } from '../crawler/queue/crawl-queue.interface';
import type { SchedulerService } from '../crawler/queue/scheduler.service';
import type { PrismaService } from '../prisma/prisma.service';
import { CrawlJobsService } from './crawl-jobs.service';

/**
 * The MANUAL trigger path — "Run now" on a job.
 *
 * This had no test at all, and that is exactly how it broke: SchedulerService grew
 * the keyword fan-out, its spec covered the CRON path, and this one kept creating a
 * single keyword-less run. Every sweep triggered from the UI failed with "Amazon
 * search requires a query" while the whole suite stayed green.
 *
 * Two trigger paths, one tested. These tests exist so there is no untested second
 * way to turn a job into runs.
 */
describe('CrawlJobsService.trigger', () => {
  function make(opts: {
    type: CrawlJobType;
    outstanding?: number;
    runIds?: string[];
  }) {
    const queued: Array<{ jobId: string; trigger: RunTrigger }> = [];
    const runIds = opts.runIds ?? ['run_1', 'run_2', 'run_3'];

    const prisma = {
      crawlJob: {
        findUnique: () =>
          Promise.resolve({
            id: 'job_1',
            name: 'Daily keyword sweep (Amazon)',
            type: opts.type,
            marketplace: Marketplace.AMAZON,
          }),
      },
      crawlRun: {
        count: () => Promise.resolve(opts.outstanding ?? 0),
        findMany: () =>
          Promise.resolve(
            runIds.map((id, i) => ({
              id,
              jobId: 'job_1',
              keywordId: `kw_${i}`,
              batchId: 'batch_1',
              status: 'QUEUED',
              trigger: RunTrigger.MANUAL,
              startedAt: null,
              finishedAt: null,
              itemsFound: 0,
              itemsNew: 0,
              itemsUpdated: 0,
              error: null,
              createdAt: new Date(0),
              job: {
                name: 'Daily keyword sweep (Amazon)',
                marketplace: Marketplace.AMAZON,
              },
              keyword: { text: `keyword ${i}` },
            })),
          ),
      },
    } as unknown as PrismaService;

    const scheduler = {
      // The single implementation of "job -> runs". This spec asserts trigger()
      // DELEGATES to it rather than rolling its own — the duplicate was the bug.
      queueRunsFor: (job: { id: string }, trigger: RunTrigger) => {
        queued.push({ jobId: job.id, trigger });
        return Promise.resolve(runIds);
      },
    } as unknown as SchedulerService;

    const service = new CrawlJobsService(
      prisma,
      scheduler,
      {} as AdapterRegistry,
      {} as ICrawlQueue,
    );
    return { service, queued };
  }

  /**
   * THE REGRESSION.
   *
   * A sweep is N runs, one per keyword. trigger() used to create exactly one, with
   * no keywordId — so collect() had no search term and every adapter threw.
   */
  it('fans a sweep out to one run per keyword, via the scheduler', async () => {
    const { service, queued } = make({ type: CrawlJobType.KEYWORD_SWEEP });

    const runs = await service.trigger('job_1');

    expect(runs).toHaveLength(3);
    // Every run carries its keyword — the thing whose absence caused the failure.
    expect(runs.every((r) => r.keyword)).toBe(true);
    expect(queued).toEqual([{ jobId: 'job_1', trigger: RunTrigger.MANUAL }]);
  });

  /** A human clicked it, so the run must say MANUAL — not the cron's SCHEDULED. */
  it('marks the runs MANUAL', async () => {
    const { service, queued } = make({ type: CrawlJobType.KEYWORD_SWEEP });
    await service.trigger('job_1');
    expect(queued[0].trigger).toBe(RunTrigger.MANUAL);
  });

  it('still produces a single run for a PRODUCT_URLS job', async () => {
    const { service } = make({
      type: CrawlJobType.PRODUCT_URLS,
      runIds: ['run_1'],
    });
    await expect(service.trigger('job_1')).resolves.toHaveLength(1);
  });

  /**
   * Queuing nothing and reporting success is the failure mode this whole feature
   * keeps hitting: the user watches a runs list that never changes.
   */
  it('rejects rather than silently queueing nothing when a sweep tracks no keywords', async () => {
    const { service } = make({ type: CrawlJobType.KEYWORD_SWEEP, runIds: [] });
    await expect(service.trigger('job_1')).rejects.toThrow(BadRequestException);
  });

  it('refuses to stack a run on a job that already has one outstanding', async () => {
    const { service, queued } = make({
      type: CrawlJobType.KEYWORD_SWEEP,
      outstanding: 2,
    });
    await expect(service.trigger('job_1')).rejects.toThrow(BadRequestException);
    expect(queued).toHaveLength(0);
  });

  it('404s on an unknown job', async () => {
    const prisma = {
      crawlJob: { findUnique: () => Promise.resolve(null) },
    } as unknown as PrismaService;
    const service = new CrawlJobsService(
      prisma,
      {} as SchedulerService,
      {} as AdapterRegistry,
      {} as ICrawlQueue,
    );
    await expect(service.trigger('nope')).rejects.toThrow(NotFoundException);
  });
});
