import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { CrawlJobsModule } from './crawl-jobs/crawl-jobs.module';
import { CrawlerModule } from './crawler/crawler.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductsModule } from './products/products.module';
import { StatsModule } from './stats/stats.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fail at boot on bad config rather than at the first request that needs it.
      validate: validateEnv,
      envFilePath: ['.env'],
      cache: true,
    }),
    PrismaModule,
    CrawlerModule,
    ProductsModule,
    CrawlJobsModule,
    StatsModule,
    HealthModule,
  ],
})
export class AppModule {}
