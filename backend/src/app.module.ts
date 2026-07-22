import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { StatsModule } from './stats/stats.module';
import { PrismaModule } from './prisma/prisma.module';
import { validateEnv } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { CrawlerModule } from './crawler/crawler.module';
import { LoggingModule } from './logging/logging.module';
import { KeywordsModule } from './keywords/keywords.module';
import { ProductsModule } from './products/products.module';
import { CrawlJobsModule } from './crawl-jobs/crawl-jobs.module';
import { DiagnosticsModule } from './diagnostics/diagnostics.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fail at boot on bad config rather than at the first request that needs it.
      validate: validateEnv,
      envFilePath: ['.env'],
      cache: true,
    }),
    LoggingModule,
    PrismaModule,
    CrawlerModule,
    ProductsModule,
    KeywordsModule,
    CrawlJobsModule,
    StatsModule,
    HealthModule,
    DiagnosticsModule,
  ],
})
export class AppModule {}
