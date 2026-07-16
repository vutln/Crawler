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
import { CRAWL_QUEUE, type ICrawlQueue } from '../crawler/queue/crawl-queue.interface';
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

type RunWithJob = CrawlRun & { job: Pick<CrawlJob, 'name' | 'marketplace'> };

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
        query: dto.query ?? null,
        urls: dto.urls ? (dto.urls as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        maxPages: dto.maxPages,
        maxItems: dto.maxItems,
        cronExpression: dto.cronExpression ?? null,
        enabled: dto.enabled,
      },
    });

    await this.scheduler.reconcileJob(job.id);
    return this.toJobDto(job, null);
  }

  async findAll(): Promise<CrawlJobDto[]> {
    const jobs = await this.prisma.crawlJob.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        runs: {
          orderBy: { createdAt: 'desc' },
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
        runs: {
          orderBy: { createdAt: 'desc' },
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
        ...(dto.query !== undefined && { query: dto.query }),
        ...(dto.urls !== undefined && { urls: dto.urls as unknown as Prisma.InputJsonValue }),
        ...(dto.maxPages !== undefined && { maxPages: dto.maxPages }),
        ...(dto.maxItems !== undefined && { maxItems: dto.maxItems }),
        ...(dto.cronExpression !== undefined && { cronExpression: dto.cronExpression }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
      },
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
      where: { jobId: id, status: { in: [RunStatus.QUEUED, RunStatus.RUNNING] } },
    });
    if (outstanding > 0) {
      throw new BadRequestException('This job already has a run queued or in progress');
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
    };

    const [items, total] = await Promise.all([
      this.prisma.crawlRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { job: { select: { name: true, marketplace: true } } },
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
      include: { job: { select: { name: true, marketplace: true } } },
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

  private toJobDto(job: CrawlJob, lastRun: RunWithJob | null): CrawlJobDto {
    return {
      id: job.id,
      name: job.name,
      marketplace: job.marketplace,
      type: job.type,
      query: job.query,
      urls: Array.isArray(job.urls) ? (job.urls as string[]) : null,
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
