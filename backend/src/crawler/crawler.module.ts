import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { MARKETPLACE_ADAPTER, type MarketplaceAdapter } from './adapters/adapter.interface';
import { AdapterRegistry } from './adapters/adapter.registry';
import { AmazonSeleniumAdapter } from './adapters/amazon/amazon-selenium.adapter';
import { EbayApiAdapter } from './adapters/ebay/ebay-api.adapter';
import { EbaySeleniumAdapter } from './adapters/ebay/ebay-selenium.adapter';
import { EtsyApiAdapter } from './adapters/etsy/etsy-api.adapter';
import { EtsySeleniumAdapter } from './adapters/etsy/etsy-selenium.adapter';
import { WebDriverFactory } from './driver/webdriver.factory';
import { CrawlRunnerService } from './pipeline/crawl-runner.service';
import { BlockDetectorService } from './politeness/block-detector.service';
import { RobotsService } from './politeness/robots.service';
import { ThrottleService } from './politeness/throttle.service';
import { CRAWL_QUEUE } from './queue/crawl-queue.interface';
import { InMemoryCrawlQueue } from './queue/in-memory-crawl.queue';
import { SchedulerService } from './queue/scheduler.service';

/**
 * TO ADD A MARKETPLACE:
 *   1. Add the value to `enum Marketplace` in prisma/schema.prisma + migrate.
 *   2. Write one class implementing MarketplaceAdapter (extend
 *      SeleniumAdapterBase for robots/throttle/block-detection).
 *   3. Add it here.
 * Nothing else changes — not the runner, queue, registry, controllers or DTOs.
 */
const ADAPTERS = [
  // Priority 100 — self-disable without credentials.
  EbayApiAdapter,
  EtsyApiAdapter,
  // Priority 10 — always available, so the app works with an empty .env.
  AmazonSeleniumAdapter,
  EbaySeleniumAdapter,
  EtsySeleniumAdapter,
];

@Module({
  imports: [ConfigModule, ScheduleModule.forRoot()],
  providers: [
    // Politeness + driver infrastructure
    WebDriverFactory,
    RobotsService,
    ThrottleService,
    BlockDetectorService,

    ...ADAPTERS,

    // useFactory, not a literal array: the token must resolve to the same
    // singletons Nest constructed above, not a second unrelated set.
    {
      provide: MARKETPLACE_ADAPTER,
      useFactory: (...adapters: MarketplaceAdapter[]) => adapters,
      inject: ADAPTERS,
    },

    AdapterRegistry,
    CrawlRunnerService,

    // Swap for a BullMqCrawlQueue and nothing else changes.
    { provide: CRAWL_QUEUE, useClass: InMemoryCrawlQueue },

    SchedulerService,
  ],
  exports: [AdapterRegistry, CrawlRunnerService, CRAWL_QUEUE, SchedulerService],
})
export class CrawlerModule {}
