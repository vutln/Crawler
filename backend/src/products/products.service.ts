import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Product } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListProductsDto } from './dto/list-products.dto';
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

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListProductsDto): Promise<PaginatedProductsDto> {
    const where: Prisma.ProductWhereInput = {};

    if (query.search) where.title = { contains: query.search };
    if (query.marketplace) where.marketplace = query.marketplace;
    if (query.inStock !== undefined) where.inStock = query.inStock;

    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      where.currentPrice = {
        ...(query.minPrice !== undefined && { gte: new Prisma.Decimal(query.minPrice) }),
        ...(query.maxPrice !== undefined && { lte: new Prisma.Decimal(query.maxPrice) }),
      };
    }

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
        select: { capturedAt: true, price: true, currency: true, inStock: true },
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
    const format = interval === PriceHistoryInterval.Hour ? '%Y-%m-%d %H:00:00' : '%Y-%m-%d 00:00:00';

    const rows = await this.prisma.$queryRaw<
      Array<{ bucket: string; price: Prisma.Decimal | null; currency: string; inStock: number }>
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
      rows.map((r) => [r.productId, r.basePrice === null ? null : Number(r.basePrice)]),
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
      result.set(product.id, Math.round(((current - base) / base) * 10000) / 100);
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
