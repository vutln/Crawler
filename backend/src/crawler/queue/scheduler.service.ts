import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { RunStatus, RunTrigger } from '../../generated/prisma/client';
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(CRAWL_QUEUE) private readonly queue: ICrawlQueue,
  ) {}

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
      cronJob = new CronJob(cronExpression, () => {
        void this.trigger(jobId, label);
      });
    } catch (err) {
      // A malformed expression must not take the whole app down at boot.
      this.logger.error(
        `Job "${label}" has an invalid cron expression "${cronExpression}": ${(err as Error).message}`,
      );
      return;
    }

    this.schedulerRegistry.addCronJob(name, cronJob);
    cronJob.start();
    this.logger.log(`Scheduled "${label}" (${cronExpression})`);
  }

  private async trigger(jobId: string, label: string): Promise<void> {
    try {
      // Skip if this job already has work outstanding. A slow hourly crawl that
      // takes 70 minutes must not stack up runs until the queue explodes.
      const outstanding = await this.prisma.crawlRun.count({
        where: { jobId, status: { in: [RunStatus.QUEUED, RunStatus.RUNNING] } },
      });
      if (outstanding > 0) {
        this.logger.warn(`Skipping "${label}" — previous run still in progress`);
        return;
      }

      const run = await this.prisma.crawlRun.create({
        data: { jobId, status: RunStatus.QUEUED, trigger: RunTrigger.SCHEDULED },
      });
      await this.queue.enqueue(run.id);
    } catch (err) {
      this.logger.error(`Failed to trigger "${label}": ${(err as Error).message}`);
    }
  }
}
