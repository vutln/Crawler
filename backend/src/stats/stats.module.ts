import { Module } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Controller, Get, Injectable } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CrawlerModule } from '../crawler/crawler.module';
import { AdapterRegistry } from '../crawler/adapters/adapter.registry';
import { Marketplace, RunStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export class MarketplaceStatDto {
  @ApiProperty({ enum: Marketplace, enumName: 'Marketplace' })
  marketplace!: Marketplace;
  @ApiProperty() productCount!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Adapter currently serving this marketplace',
  })
  activeAdapter!: string | null;
}

export class StatsOverviewDto {
  @ApiProperty() totalProducts!: number;
  @ApiProperty() totalSnapshots!: number;
  @ApiProperty({ description: 'Runs currently QUEUED or RUNNING' })
  activeRuns!: number;
  @ApiProperty() totalJobs!: number;
  @ApiProperty({ description: 'Products whose price moved in the last 24h' })
  priceChanges24h!: number;
  @ApiProperty({ type: [MarketplaceStatDto] })
  byMarketplace!: MarketplaceStatDto[];
}

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AdapterRegistry,
  ) {}

  async overview(): Promise<StatsOverviewDto> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      totalProducts,
      totalSnapshots,
      activeRuns,
      totalJobs,
      grouped,
      changes,
    ] = await Promise.all([
      this.prisma.product.count(),
      this.prisma.priceSnapshot.count(),
      this.prisma.crawlRun.count({
        where: { status: { in: [RunStatus.QUEUED, RunStatus.RUNNING] } },
      }),
      this.prisma.crawlJob.count(),
      this.prisma.product.groupBy({
        by: ['marketplace'],
        _count: { _all: true },
      }),
      this.priceChanges24h(since),
    ]);

    const adapters = new Map(
      this.registry.describe().map((d) => [d.marketplace, d.active]),
    );
    const counts = new Map(grouped.map((g) => [g.marketplace, g._count._all]));

    return {
      totalProducts,
      totalSnapshots,
      activeRuns,
      totalJobs,
      priceChanges24h: changes,
      // Every marketplace, not just ones with data — an empty AMAZON row still
      // tells you which adapter is wired up.
      byMarketplace: Object.values(Marketplace).map((marketplace) => ({
        marketplace,
        productCount: counts.get(marketplace) ?? 0,
        activeAdapter: adapters.get(marketplace) ?? null,
      })),
    };
  }

  /** Products with more than one distinct price in the window. */
  private async priceChanges24h(since: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*) AS n FROM (
        SELECT productId
        FROM PriceSnapshot
        WHERE capturedAt >= ${since} AND price IS NOT NULL
        GROUP BY productId
        HAVING COUNT(DISTINCT price) > 1
      ) AS changed
    `;
    return Number(rows[0]?.n ?? 0);
  }
}

@ApiTags('stats')
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Dashboard summary counters' })
  @ApiOkResponse({ type: StatsOverviewDto })
  overview(): Promise<StatsOverviewDto> {
    return this.stats.overview();
  }
}

@Module({
  imports: [CrawlerModule],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
