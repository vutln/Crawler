import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { randomUUID } from 'node:crypto';
import { CrawlJobType, RunStatus, RunTrigger, type CrawlJob } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CRAWL_QUEUE, type ICrawlQueue } from './crawl-queue.interface';

/**
 * Turns CrawlJob.cronExpression into actual recurring runs.
 *
 * Cron jobs are registered dynamically from the database rather than declared
 * with @Cron decorators, because schedules are user data — they're created and
 * edited through the API at runtime, and a decorator is fixed at compile time.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);
  private static readonly PREFIX = 'crawl-job:';
  private readonly timezone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(CRAWL_QUEUE) private readonly queue: ICrawlQueue,
    private readonly config: ConfigService,
  ) {
    this.timezone = this.config.get<string>('CRAWL_TIMEZONE', 'UTC');
  }

  async onModuleInit(): Promise<void> {
    await this.reconcileAll();
  }

  /** Rebuild every cron registration from the DB. Called at boot and after job edits. */
  async reconcileAll(): Promise<void> {
    for (const name of this.schedulerRegistry.getCronJobs().keys()) {
      if (name.startsWith(SchedulerService.PREFIX)) {
        this.schedulerRegistry.deleteCronJob(name);
      }
    }

    const jobs = await this.prisma.crawlJob.findMany({
      where: { enabled: true, cronExpression: { not: null } },
    });

    for (const job of jobs) {
      this.register(job.id, job.cronExpression!, job.name);
    }
    this.logger.log(`Registered ${jobs.length} scheduled crawl job(s)`);
  }

  /** Re-register a single job after create/update/delete. */
  async reconcileJob(jobId: string): Promise<void> {
    const name = SchedulerService.PREFIX + jobId;
    if (this.schedulerRegistry.doesExist('cron', name)) {
      this.schedulerRegistry.deleteCronJob(name);
    }

    const job = await this.prisma.crawlJob.findUnique({ where: { id: jobId } });
    if (job?.enabled && job.cronExpression) {
      this.register(job.id, job.cronExpression, job.name);
    }
  }

  private register(jobId: string, cronExpression: string, label: string): void {
    const name = SchedulerService.PREFIX + jobId;

    let cronJob: CronJob;
    try {
      cronJob = new CronJob(
        cronExpression,
        () => {
          void this.trigger(jobId, label);
        },
        null,
        false,
        // Without this the `cron` package uses the SERVER's local time, so a
        // "daily 06:00" sweep on an ICT machine fires at 23:00 UTC the previous
        // day and every capturedAt lands in the wrong day for a US price series.
        // Also validated here: an invalid IANA name throws, and the catch below
        // turns that into a skipped job rather than a dead boot.
        this.timezone,
      );
    } catch (err) {
      // A malformed expression (or timezone) must not take the whole app down.
      this.logger.error(
        `Job "${label}" has an invalid cron expression "${cronExpression}" ` +
          `or timezone "${this.timezone}": ${(err as Error).message}`,
      );
      return;
    }

    this.schedulerRegistry.addCronJob(name, cronJob);
    cronJob.start();
    this.logger.log(`Scheduled "${label}" (${cronExpression} ${this.timezone})`);
  }

  private async trigger(jobId: string, label: string): Promise<void> {
    try {
      // Skip if this job already has work outstanding. A slow hourly crawl that
      // takes 70 minutes must not stack up runs until the queue explodes.
      //
      // Works unchanged for a sweep, and that is the payoff of keeping one job per
      // marketplace: all N of yesterday's keyword runs share this jobId, so
      // "yesterday's Amazon sweep hasn't finished" correctly suppresses today's
      // fire — while eBay, a different job, is untouched.
      const outstanding = await this.prisma.crawlRun.count({
        where: { jobId, status: { in: [RunStatus.QUEUED, RunStatus.RUNNING] } },
      });
      if (outstanding > 0) {
        this.logger.warn(`Skipping "${label}" — previous run still in progress`);
        return;
      }

      const job = await this.prisma.crawlJob.findUnique({ where: { id: jobId } });
      if (!job) {
        this.logger.warn(`Skipping "${label}" — job no longer exists`);
        return;
      }

      await this.queueRunsFor(job, RunTrigger.SCHEDULED);
    } catch (err) {
      this.logger.error(`Failed to trigger "${label}": ${(err as Error).message}`);
    }
  }

  /**
   * Turn a job into runs and queue them. Returns the created run ids.
   *
   * PUBLIC because both trigger paths must go through it: the cron above, and the
   * manual "Run now" in CrawlJobsService. When only the cron knew how to fan out,
   * clicking Run now on a sweep created ONE keyword-less run and every adapter
   * threw "search requires a query" — the button was broken for every sweep job.
   *
   * So this is the single place that knows a sweep becomes N runs. A second
   * implementation is what caused the bug; there must not be one.
   */
  async queueRunsFor(job: CrawlJob, trigger: RunTrigger): Promise<string[]> {
    const runIds =
      job.type === CrawlJobType.KEYWORD_SWEEP
        ? await this.fanOut(job, trigger)
        : [await this.createSingleRun(job.id, trigger)];

    for (const runId of runIds) {
      await this.queue.enqueue(runId);
    }
    return runIds;
  }

  /**
   * One QUEUED run per keyword this job tracks, all sharing a batchId.
   *
   * This is where "a list of keywords, daily, on three sites" actually happens:
   * the cron fires once per marketplace and expands against the keyword table, so
   * adding a keyword changes tomorrow's output with no cron registration touched.
   *
   * createMany + re-read rather than N creates: MySQL cannot return rows from
   * createMany, but one insert for 20 keywords beats 20 round-trips, and the
   * batchId gives us a precise handle to read back.
   */
  private async fanOut(job: CrawlJob, trigger: RunTrigger): Promise<string[]> {
    /**
     * The job's selection is the ONLY thing that decides what it collects.
     *
     * There used to be an `enabled` AND-condition here — a global per-keyword flag
     * that could veto a job's explicit selection, so a job could select a keyword
     * and silently not collect it. It's gone: what a job collects is now readable
     * from the job alone.
     */
    const keywords = await this.prisma.keyword.findMany({
      where: job.trackAllKeywords
        ? // The whole point of the flag: everything, including keywords added after
          // this job was configured.
          {}
        : { jobs: { some: { jobId: job.id } } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    if (keywords.length === 0) {
      // Not an error: an empty selection is a configuration state, and a sweep with
      // nothing to sweep should say so rather than look broken. The two causes need
      // different fixes, so name which one it is.
      this.logger.warn(
        job.trackAllKeywords
          ? `"${job.name}" fired but there are no keywords at all — nothing to collect`
          : `"${job.name}" fired but no keywords are selected for it — nothing to collect`,
      );
      return [];
    }

    const batchId = randomUUID();
    await this.prisma.crawlRun.createMany({
      data: keywords.map((k) => ({
        jobId: job.id,
        keywordId: k.id,
        batchId,
        status: RunStatus.QUEUED,
        // MANUAL when a human clicked Run now, SCHEDULED when the cron fired.
        // Hardcoding SCHEDULED here would have mislabelled every manual sweep.
        trigger,
      })),
    });

    const runs = await this.prisma.crawlRun.findMany({
      where: { batchId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    this.logger.log(`"${job.name}" fanned out to ${runs.length} keyword(s) — batch ${batchId}`);
    return runs.map((r) => r.id);
  }

  private async createSingleRun(jobId: string, trigger: RunTrigger): Promise<string> {
    const run = await this.prisma.crawlRun.create({
      data: { jobId, status: RunStatus.QUEUED, trigger },
    });
    return run.id;
  }
}
