import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CronTime } from 'cron';
import {
  Prisma,
  RunStatus,
  RunTrigger,
  type CrawlJob,
  type CrawlRun,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CRAWL_QUEUE,
  type ICrawlQueue,
} from '../crawler/queue/crawl-queue.interface';
import { SchedulerService } from '../crawler/queue/scheduler.service';
import { AdapterRegistry } from '../crawler/adapters/adapter.registry';
import {
  CreateCrawlJobDto,
  ListCrawlRunsDto,
  UpdateCrawlJobDto,
  type CrawlJobDto,
  type CrawlRunDto,
  type PaginatedCrawlRunsDto,
} from './dto/crawl-job.dto';

type RunWithJob = CrawlRun & {
  job: Pick<CrawlJob, 'name' | 'marketplace'>;
  /** Optional so the lastRun lookups, which don't need it, keep type-checking. */
  keyword?: { text: string } | null;
};

/**
 * Every read of a job needs its keyword selection — the UI must say what a job
 * collects, and "0 keywords" vs "all keywords" is exactly the ambiguity
 * trackAllKeywords exists to remove. Shared so one query can't forget it and
 * silently report an empty selection.
 */
const JOB_INCLUDE = {
  keywords: {
    include: { keyword: { select: { id: true, text: true } } },
  },
} as const;

type JobWithKeywords = CrawlJob & {
  keywords?: Array<{ keyword: { id: string; text: string } }>;
};

@Injectable()
export class CrawlJobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerService,
    private readonly registry: AdapterRegistry,
    @Inject(CRAWL_QUEUE) private readonly queue: ICrawlQueue,
  ) {}

  async create(dto: CreateCrawlJobDto): Promise<CrawlJobDto> {
    this.assertValidCron(dto.cronExpression);
    // Fail fast if nothing can serve this marketplace, rather than accepting the
    // job and having every run fail later.
    this.registry.resolve(dto.marketplace);

    const job = await this.prisma.crawlJob.create({
      data: {
        name: dto.name,
        marketplace: dto.marketplace,
        type: dto.type,
        urls: dto.urls
          ? (dto.urls as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
        maxPages: dto.maxPages,
        maxItems: dto.maxItems,
        cronExpression: dto.cronExpression ?? null,
        enabled: dto.enabled,
        trackAllKeywords: dto.trackAllKeywords,
        // Stored even when trackAllKeywords is true: the selection is then unused,
        // not discarded, so toggling the flag off later restores the picks rather
        // than silently emptying them.
        ...(dto.keywordIds?.length && {
          keywords: { create: dto.keywordIds.map((keywordId) => ({ keywordId })) },
        }),
      },
      include: JOB_INCLUDE,
    });

    await this.scheduler.reconcileJob(job.id);
    return this.toJobDto(job, null);
  }

  async findAll(): Promise<CrawlJobDto[]> {
    const jobs = await this.prisma.crawlJob.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        ...JOB_INCLUDE,
        runs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { job: { select: { name: true, marketplace: true } } },
        },
      },
    });
    return jobs.map((job) => this.toJobDto(job, job.runs[0] ?? null));
  }

  async findOne(id: string): Promise<CrawlJobDto> {
    const job = await this.prisma.crawlJob.findUnique({
      where: { id },
      include: {
        ...JOB_INCLUDE,
        runs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { job: { select: { name: true, marketplace: true } } },
        },
      },
    });
    if (!job) throw new NotFoundException(`Crawl job ${id} not found`);
    return this.toJobDto(job, job.runs[0] ?? null);
  }

  async update(id: string, dto: UpdateCrawlJobDto): Promise<CrawlJobDto> {
    if (dto.cronExpression) this.assertValidCron(dto.cronExpression);
    await this.findOne(id);

    const job = await this.prisma.crawlJob.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.urls !== undefined && {
          urls: dto.urls as unknown as Prisma.InputJsonValue,
        }),
        ...(dto.maxPages !== undefined && { maxPages: dto.maxPages }),
        ...(dto.maxItems !== undefined && { maxItems: dto.maxItems }),
        ...(dto.cronExpression !== undefined && {
          cronExpression: dto.cronExpression,
        }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.trackAllKeywords !== undefined && {
          trackAllKeywords: dto.trackAllKeywords,
        }),
        /**
         * Replace the selection wholesale, in one transaction with the rest.
         *
         * deleteMany + create rather than a diff: the client sends the full list it
         * wants, so computing an add/remove delta here would be work whose only
         * product is a chance to get it wrong. Undefined means "don't touch" —
         * distinct from an empty array, which means "select nothing".
         */
        ...(dto.keywordIds !== undefined && {
          keywords: {
            deleteMany: {},
            create: dto.keywordIds.map((keywordId) => ({ keywordId })),
          },
        }),
      },
      include: JOB_INCLUDE,
    });

    // The cron registration is derived state; rebuild it whenever the source changes.
    await this.scheduler.reconcileJob(id);
    return this.toJobDto(job, null);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.prisma.crawlJob.delete({ where: { id } });
    await this.scheduler.reconcileJob(id); // removes the cron registration
  }

  /** Queue a run now. Returns immediately — the dashboard polls for progress. */
  async trigger(id: string): Promise<CrawlRunDto> {
    const job = await this.prisma.crawlJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Crawl job ${id} not found`);

    const outstanding = await this.prisma.crawlRun.count({
      where: {
        jobId: id,
        status: { in: [RunStatus.QUEUED, RunStatus.RUNNING] },
      },
    });
    if (outstanding > 0) {
      throw new BadRequestException(
        'This job already has a run queued or in progress',
      );
    }

    const run = await this.prisma.crawlRun.create({
      data: { jobId: id, status: RunStatus.QUEUED, trigger: RunTrigger.MANUAL },
      include: { job: { select: { name: true, marketplace: true } } },
    });

    await this.queue.enqueue(run.id);
    return this.toRunDto(run);
  }

  async listRuns(query: ListCrawlRunsDto): Promise<PaginatedCrawlRunsDto> {
    const where: Prisma.CrawlRunWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.jobId && { jobId: query.jobId }),
      ...(query.marketplace && { job: { marketplace: query.marketplace } }),
      ...(query.keywordId && { keywordId: query.keywordId }),
      ...(query.batchId && { batchId: query.batchId }),
    };

    const [items, total] = await Promise.all([
      this.prisma.crawlRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          job: { select: { name: true, marketplace: true } },
          keyword: { select: { text: true } },
        },
      }),
      this.prisma.crawlRun.count({ where }),
    ]);

    return {
      items: items.map((r) => this.toRunDto(r)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findRun(id: string): Promise<CrawlRunDto> {
    const run = await this.prisma.crawlRun.findUnique({
      where: { id },
      include: {
        job: { select: { name: true, marketplace: true } },
        // Without this the relation is simply absent and toRunDto reports
        // keyword: null — indistinguishable from a run that has no keyword.
        keyword: { select: { text: true } },
      },
    });
    if (!run) throw new NotFoundException(`Crawl run ${id} not found`);
    return this.toRunDto(run);
  }

  async cancelRun(id: string): Promise<CrawlRunDto> {
    const run = await this.findRun(id);
    if (run.status !== RunStatus.QUEUED && run.status !== RunStatus.RUNNING) {
      throw new BadRequestException(`Run is already ${run.status}`);
    }
    await this.queue.cancel(id);
    return this.findRun(id);
  }

  /**
   * Validate the cron expression at the API boundary. Without this a typo is
   * accepted here and only surfaces as a log line at next boot, by which point
   * the job silently never runs.
   */
  private assertValidCron(expression?: string | null): void {
    if (!expression) return;
    try {
      new CronTime(expression);
    } catch (err) {
      throw new BadRequestException(
        `Invalid cron expression "${expression}": ${(err as Error).message}`,
      );
    }
  }

  private toJobDto(job: JobWithKeywords, lastRun: RunWithJob | null): CrawlJobDto {
    return {
      id: job.id,
      name: job.name,
      marketplace: job.marketplace,
      type: job.type,
      urls: Array.isArray(job.urls) ? (job.urls as string[]) : null,
      trackAllKeywords: job.trackAllKeywords,
      // Empty when trackAllKeywords is true — that's the flag doing its job, not a
      // missing include. Callers must read the flag before the array.
      keywords: (job.keywords ?? []).map((k) => k.keyword),
      maxPages: job.maxPages,
      maxItems: job.maxItems,
      cronExpression: job.cronExpression,
      enabled: job.enabled,
      createdAt: job.createdAt.toISOString(),
      lastRun: lastRun ? this.toRunDto(lastRun) : null,
    };
  }

  private toRunDto(run: RunWithJob): CrawlRunDto {
    return {
      id: run.id,
      jobId: run.jobId,
      jobName: run.job.name,
      marketplace: run.job.marketplace,
      // `?? null` twice on purpose: undefined means the caller didn't include the
      // relation (the lastRun lookups don't), null means a run with no keyword.
      // The DTO must not leak `undefined` into JSON, where the key would vanish.
      keyword: run.keyword?.text ?? null,
      batchId: run.batchId ?? null,
      status: run.status,
      trigger: run.trigger,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      itemsFound: run.itemsFound,
      itemsNew: run.itemsNew,
      itemsUpdated: run.itemsUpdated,
      error: run.error,
      createdAt: run.createdAt.toISOString(),
      durationMs:
        run.startedAt && run.finishedAt
          ? run.finishedAt.getTime() - run.startedAt.getTime()
          : null,
    };
  }
}
