import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CrawlJobType,
  Marketplace,
  RunStatus,
  RunTrigger,
  type Keyword,
} from '../generated/prisma/client';
import { CRAWL_QUEUE, type ICrawlQueue } from '../crawler/queue/crawl-queue.interface';
import { PrismaService } from '../prisma/prisma.service';
import {
  BulkCreateKeywordsDto,
  BulkCreateKeywordsResultDto,
  CreateKeywordDto,
  KeywordDto,
  RunKeywordResultDto,
  UpdateKeywordDto,
} from './dto/keyword.dto';

type KeywordWithCount = Keyword & { _count?: { products: number } };

/**
 * The keyword list — the data behind the configuration screen.
 *
 * Everything here exists to keep one invariant true: `Keyword.text` is stored
 * normalized, always. The @unique index in the schema enforces uniqueness over
 * exactly what is stored, so if any write path skipped normalizeText() then
 * "Mug ", "mug" and "MUG" would all coexist and the daily sweep would crawl the
 * same term three times, on three sites, forever.
 */
@Injectable()
export class KeywordsService {
  private readonly logger = new Logger(KeywordsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CRAWL_QUEUE) private readonly queue: ICrawlQueue,
  ) {}

  /**
   * The single definition of keyword identity. Every write goes through this.
   *
   * Collapsing internal whitespace matters as much as trimming: pasted lists
   * routinely carry double spaces and tabs, and "harry  potter" would otherwise be
   * a distinct row from "harry potter" while producing an identical search URL —
   * a duplicate the operator cannot see, because the two render the same.
   *
   * toLowerCase is safe here because these are search queries, not display text:
   * every adapter feeds this straight into encodeURIComponent, and no marketplace
   * search is case-sensitive.
   */
  static normalizeText(raw: string): string {
    return raw.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  async findAll(): Promise<KeywordDto[]> {
    const keywords = await this.prisma.keyword.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { products: true } } },
    });
    return keywords.map((k) => this.toDto(k));
  }

  async findOne(id: string): Promise<KeywordDto> {
    const keyword = await this.prisma.keyword.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });
    if (!keyword) throw new NotFoundException(`Keyword ${id} not found`);
    return this.toDto(keyword);
  }

  async create(dto: CreateKeywordDto): Promise<KeywordDto> {
    // 400, not 409: whitespace-only is an invalid request, not a collision with
    // existing state. @MinLength(1) can't catch it — "   " is three characters and
    // only becomes empty after normalizeText.
    const text = KeywordsService.normalizeText(dto.text);
    if (!text) throw new BadRequestException('Keyword cannot be blank');

    const existing = await this.prisma.keyword.findUnique({ where: { text } });
    if (existing) {
      // Explicit 409 rather than letting Prisma's P2002 surface as a 500. Note the
      // message quotes the NORMALIZED text: a user who typed "Mechanical Keyboard"
      // needs to know it collided with "mechanical keyboard", or the rejection
      // looks like a bug.
      throw new ConflictException(`Keyword "${text}" already exists`);
    }

    const keyword = await this.prisma.keyword.create({
      data: { text, enabled: dto.enabled ?? true, notes: dto.notes ?? null },
      include: { _count: { select: { products: true } } },
    });
    return this.toDto(keyword);
  }

  /**
   * Paste a list. Existing terms are skipped, not rejected.
   *
   * Deliberately NOT createMany({ skipDuplicates: true }): that would report
   * nothing useful back. The screen needs to say "12 added, 3 already there",
   * because a silent no-op on a 50-line paste is indistinguishable from a bug.
   */
  async bulkCreate(dto: BulkCreateKeywordsDto): Promise<BulkCreateKeywordsResultDto> {
    // 1. Normalize, drop blanks, and de-dupe WITHIN the paste, preserving order.
    //    A pasted column routinely repeats itself; those are duplicates, and they
    //    are reported separately from terms that already exist on the server.
    const seen = new Set<string>();
    const duplicates: string[] = [];
    const candidates: string[] = [];

    for (const raw of dto.keywords) {
      const text = KeywordsService.normalizeText(raw);
      if (!text) continue;
      if (seen.has(text)) {
        duplicates.push(text);
        continue;
      }
      seen.add(text);
      candidates.push(text);
    }

    if (candidates.length === 0) {
      return { created: [], skipped: [], duplicates };
    }

    // 2. One query, not N: at the 500-item ceiling this is the difference between
    //    a request and a stampede.
    const existing = await this.prisma.keyword.findMany({
      where: { text: { in: candidates } },
      select: { text: true },
    });
    const existingText = new Set(existing.map((k) => k.text));

    const toCreate = candidates.filter((t) => !existingText.has(t));
    const skipped = candidates.filter((t) => existingText.has(t));

    // 3. createMany then re-read: createMany cannot return rows on MySQL, and the
    //    screen needs the ids. skipDuplicates covers the race where a concurrent
    //    tab inserts between the check above and here — the DB's unique index is
    //    the real authority, not the read.
    if (toCreate.length > 0) {
      await this.prisma.keyword.createMany({
        data: toCreate.map((text) => ({ text })),
        skipDuplicates: true,
      });
    }

    const created = await this.prisma.keyword.findMany({
      where: { text: { in: toCreate } },
      include: { _count: { select: { products: true } } },
    });

    // Restore the caller's order — findMany's is unspecified, and a paste that
    // comes back shuffled looks broken.
    const order = new Map(toCreate.map((t, i) => [t, i]));
    created.sort((a, b) => (order.get(a.text) ?? 0) - (order.get(b.text) ?? 0));

    this.logger.log(
      `Bulk create: ${created.length} added, ${skipped.length} already present, ` +
        `${duplicates.length} duplicate(s) within the paste`,
    );

    return { created: created.map((k) => this.toDto(k)), skipped, duplicates };
  }

  /**
   * Collect ONE keyword right now, across every enabled sweep.
   *
   * This is what replaced the old SEARCH job type. SEARCH existed to answer "just
   * try this one term", but it did so by holding its own query — producing runs
   * with no keywordId and products no keyword pointed at, invisible to the results
   * screen. This gives the same capability inside the keyword model: the run
   * carries the keywordId like any sweep run, so its products are linked exactly
   * the same way. There is now one way to express "collect this term".
   *
   * Deliberately reuses the existing KEYWORD_SWEEP jobs rather than creating a
   * throwaway job: the sweep IS the per-marketplace plan (adapter, maxPages, cron),
   * and a parallel ad-hoc job would be a second place for that config to drift.
   */
  async runNow(id: string): Promise<RunKeywordResultDto> {
    const keyword = await this.prisma.keyword.findUnique({ where: { id } });
    if (!keyword) throw new NotFoundException(`Keyword ${id} not found`);

    /**
     * Only sweeps that actually TRACK this keyword.
     *
     * Running it on a job that excluded it would quietly contradict the operator's
     * configuration — they said "not this term on Etsy", and an ad-hoc trigger is
     * not a licence to override that. A job either tracks everything, or tracks
     * this keyword explicitly.
     */
    const sweeps = await this.prisma.crawlJob.findMany({
      where: {
        type: CrawlJobType.KEYWORD_SWEEP,
        enabled: true,
        OR: [{ trackAllKeywords: true }, { keywords: { some: { keywordId: id } } }],
      },
      orderBy: { marketplace: 'asc' },
    });
    if (sweeps.length === 0) {
      throw new BadRequestException(
        `No enabled sweep tracks "${keyword.text}", so there is nothing to run it against. ` +
          `Add it to a sweep's keywords, or set that sweep to track all keywords.`,
      );
    }

    const batchId = randomUUID();
    const queued: Marketplace[] = [];
    const skipped: string[] = [];

    for (const job of sweeps) {
      // Same guard the scheduler uses: a sweep with work outstanding must not have
      // more piled on. Per-marketplace, so a walled Amazon doesn't block eBay.
      const outstanding = await this.prisma.crawlRun.count({
        where: { jobId: job.id, status: { in: [RunStatus.QUEUED, RunStatus.RUNNING] } },
      });
      if (outstanding > 0) {
        skipped.push(job.marketplace);
        continue;
      }

      const run = await this.prisma.crawlRun.create({
        data: {
          jobId: job.id,
          keywordId: keyword.id,
          batchId,
          status: RunStatus.QUEUED,
          // MANUAL, not SCHEDULED: a human asked for this one.
          trigger: RunTrigger.MANUAL,
        },
      });
      await this.queue.enqueue(run.id);
      queued.push(job.marketplace);
    }

    this.logger.log(
      `Ad-hoc run of "${keyword.text}": queued on ${queued.join(', ') || 'nothing'}` +
        `${skipped.length ? `; skipped ${skipped.join(', ')} (busy)` : ''}`,
    );

    return { batchId, marketplaces: queued, queued: queued.length, skipped };
  }

  async update(id: string, dto: UpdateKeywordDto): Promise<KeywordDto> {
    await this.assertExists(id);

    const text = dto.text !== undefined ? KeywordsService.normalizeText(dto.text) : undefined;
    if (text !== undefined && !text) throw new BadRequestException('Keyword cannot be blank');

    if (text !== undefined) {
      const clash = await this.prisma.keyword.findUnique({ where: { text } });
      if (clash && clash.id !== id) {
        throw new ConflictException(`Keyword "${text}" already exists`);
      }
    }

    const keyword = await this.prisma.keyword.update({
      where: { id },
      data: {
        ...(text !== undefined && { text }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
      },
      include: { _count: { select: { products: true } } },
    });
    return this.toDto(keyword);
  }

  /**
   * Deleting a keyword drops its ProductKeyword links (FK cascade) but NEVER the
   * products or their price history: those rows are the collected time series and
   * outlive the reason we went looking. CrawlRun.keywordId is SetNull, so past
   * runs survive as history with their term detached.
   *
   * Disabling is usually what the operator actually wants — it stops the sweep
   * while keeping the link data intact — which is why `enabled` exists.
   */
  async remove(id: string): Promise<void> {
    await this.assertExists(id);
    await this.prisma.keyword.delete({ where: { id } });
  }

  private async assertExists(id: string): Promise<void> {
    const exists = await this.prisma.keyword.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException(`Keyword ${id} not found`);
  }

  private toDto(keyword: KeywordWithCount): KeywordDto {
    return {
      id: keyword.id,
      text: keyword.text,
      enabled: keyword.enabled,
      notes: keyword.notes,
      createdAt: keyword.createdAt.toISOString(),
      productCount: keyword._count?.products ?? 0,
    };
  }
}
