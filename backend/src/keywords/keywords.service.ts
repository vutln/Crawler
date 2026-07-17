import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { type Keyword } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  BulkCreateKeywordsDto,
  BulkCreateKeywordsResultDto,
  CreateKeywordDto,
  KeywordDto,
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

  constructor(private readonly prisma: PrismaService) {}

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
      data: { text, notes: dto.notes ?? null },
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
   * To stop collecting a term WITHOUT losing its links, deselect it on the job
   * instead — that is the narrower tool, and why there is no per-keyword pause.
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
      notes: keyword.notes,
      createdAt: keyword.createdAt.toISOString(),
      productCount: keyword._count?.products ?? 0,
    };
  }
}
