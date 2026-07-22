import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { Prisma, type Product } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { csvRow, UTF8_BOM } from './csv';
import {
  ExportProductsDto,
  ListProductsDto,
  type ProductFilters,
} from './dto/list-products.dto';
import {
  PriceHistoryInterval,
  type PaginatedProductsDto,
  type PricePointDto,
  type ProductDto,
} from './dto/product.dto';

/** Prisma Decimal -> JSON number. Decimal serializes to an object otherwise. */
function decimalToNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

/** Requirement fields first, then traceability, then identity. */
const CSV_COLUMNS = [
  'keyword',
  'marketplace',
  'title',
  'imageUrl',
  'price',
  'currency',
  'reviewCount',
  'rating',
  'inStock',
  'rank',
  'url',
  'externalId',
  'firstSeenAt',
  'lastScrapedAt',
] as const;

/**
 * Rows per DB round-trip while streaming.
 *
 * Keyset pagination, so this bounds MEMORY, not the export: 1000 rows are built,
 * written, and released before the next batch is read. The export stays flat
 * regardless of whether it returns 50 rows or 500,000.
 */
const CSV_BATCH_SIZE = 1000;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The one definition of "which products match these filters".
   *
   * Extracted so list() and streamCsv() cannot drift. That is the entire point of
   * the export: the operator filters the screen, hits Export, and gets THOSE rows.
   * If the two ever built their own WHERE, the CSV would quietly stop matching what
   * the user was looking at — and nothing would fail, so nobody would find out.
   */
  private buildWhere(query: ProductFilters): Prisma.ProductWhereInput {
    const where: Prisma.ProductWhereInput = {};

    if (query.search) where.title = { contains: query.search };
    if (query.marketplace) where.marketplace = query.marketplace;
    if (query.inStock !== undefined) where.inStock = query.inStock;

    // The keyword that surfaced the product. `some` because ProductKeyword is a
    // many-to-many: one product legitimately ranks for several keywords.
    if (query.keywordId || query.niche) {
      where.keywords = {
        some: {
          ...(query.keywordId && { keywordId: query.keywordId }),
          ...(query.niche && { keyword: { niche: query.niche } }),
        },
      };
    }

    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      where.currentPrice = {
        ...(query.minPrice !== undefined && {
          gte: new Prisma.Decimal(query.minPrice),
        }),
        ...(query.maxPrice !== undefined && {
          lte: new Prisma.Decimal(query.maxPrice),
        }),
      };
    }

    return where;
  }

  async list(query: ListProductsDto): Promise<PaginatedProductsDto> {
    const where = this.buildWhere(query);

    const orderBy: Prisma.ProductOrderByWithRelationInput =
      query.sortBy === 'price'
        ? { currentPrice: query.sortOrder }
        : { [query.sortBy]: query.sortOrder };

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);

    // One extra query for the whole page rather than one per row.
    const deltas = await this.priceChange7d(items);

    return {
      items: items.map((p) => this.toDto(p, deltas.get(p.id) ?? null)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Stream the current filter as CSV.
   *
   * Streamed, not buffered, and that is not premature: a 20-keyword sweep across 3
   * marketplaces at ~120 listings each is ~7,000 products, and the table only grows.
   * Buffering means a full findMany in memory plus a multi-megabyte string — one
   * export pins the heap and two concurrent ones can OOM the process. Streaming
   * holds one batch at a time regardless of size.
   *
   * Reuses buildWhere(), so the CSV is exactly what the screen was showing.
   */
  async streamCsv(query: ExportProductsDto, out: Writable): Promise<void> {
    const where = this.buildWhere(query);

    // Excel decodes the file as the system codepage without this, turning every
    // accented or CJK title into mojibake. Must be the first bytes on the wire.
    await this.write(out, UTF8_BOM + csvRow([...CSV_COLUMNS]));

    let cursor: string | undefined;
    let rows = 0;

    for (;;) {
      /**
       * Keyset pagination (cursor on id), not skip/take.
       *
       * OFFSET makes the database walk and discard every preceding row, so batch N
       * costs O(N * batchSize) and a large export degrades quadratically. A cursor
       * is an indexed seek — every batch costs the same. It also cannot skip or
       * duplicate rows if a concurrent crawl inserts mid-export, which OFFSET can.
       */
      const batch = await this.prisma.product.findMany({
        where,
        orderBy: { id: 'asc' },
        take: CSV_BATCH_SIZE,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        include: {
          keywords: {
            select: {
              lastRank: true,
              keyword: { select: { id: true, text: true } },
            },
          },
        },
      });

      if (batch.length === 0) break;

      let chunk = '';
      for (const product of batch) {
        chunk += this.toCsvRow(product, query.keywordId);
      }
      await this.write(out, chunk);

      rows += batch.length;
      cursor = batch[batch.length - 1].id;
      if (batch.length < CSV_BATCH_SIZE) break;
    }

    this.logger.log(`Exported ${rows} product(s) as CSV`);
    out.end();
  }

  /**
   * Write, honouring backpressure.
   *
   * res.write() returning false means the socket's buffer is full; ignoring it and
   * writing anyway just moves the whole file into Node's memory, which defeats the
   * streaming entirely. Waiting for 'drain' is what keeps this flat.
   */
  private async write(out: Writable, data: string): Promise<void> {
    if (!out.write(data)) await once(out, 'drain');
  }

  private toCsvRow(
    product: Product & {
      keywords: Array<{
        lastRank: number | null;
        keyword: { id: string; text: string };
      }>;
    },
    filteredKeywordId?: string,
  ): string {
    /**
     * Which keyword's rank to report.
     *
     * Filtered: that keyword's — the product's position for some other term is not
     * what the operator asked about.
     *
     * Unfiltered: only when the answer is unambiguous, i.e. the product was
     * surfaced by exactly one keyword. A product ranking for three terms has three
     * ranks, and picking one arbitrarily would be a number that looks authoritative
     * and means nothing. Empty is the honest answer there, and the keyword column
     * shows all three so it is obvious why.
     */
    const match = filteredKeywordId
      ? product.keywords.find((k) => k.keyword.id === filteredKeywordId)
      : product.keywords.length === 1
        ? product.keywords[0]
        : undefined;

    const keywordText = filteredKeywordId
      ? (match?.keyword.text ?? '')
      : product.keywords.map((k) => k.keyword.text).join(' | ');

    return csvRow([
      keywordText,
      product.marketplace,
      product.title,
      product.imageUrl,
      // decimalToNumber, never the Decimal: it stringifies to [object Object].
      decimalToNumber(product.currentPrice),
      // Always beside the price. After the currency work, USD is not guaranteed —
      // a price column without a currency column is the same lie normalizeCurrency
      // used to tell.
      product.currency,
      product.reviewCount,
      decimalToNumber(product.rating),
      product.inStock,
      match?.lastRank ?? null,
      product.url,
      product.externalId,
      product.firstSeenAt.toISOString(),
      product.lastScrapedAt.toISOString(),
    ]);
  }

  async findOne(id: string): Promise<ProductDto> {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found`);

    const deltas = await this.priceChange7d([product]);
    return this.toDto(product, deltas.get(id) ?? null);
  }

  /**
   * Price history for the chart.
   *
   * `interval` buckets server-side. This is not premature optimization: a
   * product scraped hourly for a year is ~8,760 points, which is both a fat
   * payload and more than a chart can meaningfully draw on 800px of screen.
   */
  async priceHistory(
    id: string,
    opts: { from?: Date; to?: Date; interval?: PriceHistoryInterval },
  ): Promise<PricePointDto[]> {
    const exists = await this.prisma.product.count({ where: { id } });
    if (!exists) throw new NotFoundException(`Product ${id} not found`);

    const { from, to, interval = PriceHistoryInterval.Raw } = opts;

    if (interval === PriceHistoryInterval.Raw) {
      const rows = await this.prisma.priceSnapshot.findMany({
        where: {
          productId: id,
          ...((from || to) && {
            capturedAt: { ...(from && { gte: from }), ...(to && { lte: to }) },
          }),
        },
        orderBy: { capturedAt: 'asc' },
        select: {
          capturedAt: true,
          price: true,
          currency: true,
          inStock: true,
        },
      });

      return rows.map((r) => ({
        capturedAt: r.capturedAt.toISOString(),
        price: decimalToNumber(r.price),
        currency: r.currency,
        inStock: r.inStock,
      }));
    }

    // Bucketed. Raw SQL because Prisma's groupBy cannot express a date_format
    // truncation as a grouping key.
    const format =
      interval === PriceHistoryInterval.Hour
        ? '%Y-%m-%d %H:00:00'
        : '%Y-%m-%d 00:00:00';

    const rows = await this.prisma.$queryRaw<
      Array<{
        bucket: string;
        price: Prisma.Decimal | null;
        currency: string;
        inStock: number;
      }>
    >`
      SELECT
        DATE_FORMAT(capturedAt, ${format})           AS bucket,
        AVG(price)                                   AS price,
        MIN(currency)                                AS currency,
        MAX(inStock)                                 AS inStock
      FROM PriceSnapshot
      WHERE productId = ${id}
        ${from ? Prisma.sql`AND capturedAt >= ${from}` : Prisma.empty}
        ${to ? Prisma.sql`AND capturedAt <= ${to}` : Prisma.empty}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    return rows.map((r) => ({
      // MySQL hands back a naive datetime string; mark it UTC explicitly or the
      // browser will re-interpret it in local time and shift every point.
      capturedAt: new Date(`${r.bucket.replace(' ', 'T')}Z`).toISOString(),
      price: r.price === null ? null : Number(r.price),
      currency: r.currency,
      inStock: Boolean(r.inStock),
    }));
  }

  /**
   * Percent change over the last 7 days, keyed by product id.
   *
   * Only the *baseline* is queried: the current price already lives on Product
   * as a denormalized mirror, so this needs the earliest in-window snapshot and
   * nothing more. FIRST_VALUE over a per-product window is MySQL 8's native way
   * to express that, and the (productId, capturedAt) index serves the partition.
   *
   * One query per page, not per row.
   */
  private async priceChange7d(
    products: Array<{ id: string; currentPrice: Prisma.Decimal | null }>,
  ): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    if (products.length === 0) return result;

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const ids = products.map((p) => p.id);

    const rows = await this.prisma.$queryRaw<
      Array<{ productId: string; basePrice: Prisma.Decimal | null }>
    >`
      SELECT DISTINCT
        productId,
        FIRST_VALUE(price) OVER (
          PARTITION BY productId
          ORDER BY capturedAt ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS basePrice
      FROM PriceSnapshot
      WHERE productId IN (${Prisma.join(ids)})
        AND capturedAt >= ${since}
        AND price IS NOT NULL
    `;

    const baseline = new Map(
      rows.map((r) => [
        r.productId,
        r.basePrice === null ? null : Number(r.basePrice),
      ]),
    );

    for (const product of products) {
      const base = baseline.get(product.id) ?? null;
      const current = decimalToNumber(product.currentPrice);

      // null, not 0, when there's no usable baseline — "unknown" and "unchanged"
      // are different facts and the UI renders them differently.
      // The base === 0 guard matters: dividing by it yields Infinity.
      if (base === null || current === null || base === 0) {
        result.set(product.id, null);
        continue;
      }
      result.set(
        product.id,
        Math.round(((current - base) / base) * 10000) / 100,
      );
    }
    return result;
  }

  private toDto(p: Product, priceChange7d: number | null): ProductDto {
    return {
      id: p.id,
      marketplace: p.marketplace,
      externalId: p.externalId,
      url: p.url,
      title: p.title,
      brand: p.brand,
      seller: p.seller,
      imageUrl: p.imageUrl,
      currency: p.currency,
      rating: decimalToNumber(p.rating),
      reviewCount: p.reviewCount,
      currentPrice: decimalToNumber(p.currentPrice),
      inStock: p.inStock,
      priceChange7d,
      snapshotCount: p.snapshotCount,
      firstSeenAt: p.firstSeenAt.toISOString(),
      lastScrapedAt: p.lastScrapedAt.toISOString(),
    };
  }
}
