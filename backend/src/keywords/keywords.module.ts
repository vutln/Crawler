import { Module } from '@nestjs/common';
import { KeywordsController } from './keywords.controller';
import { KeywordsService } from './keywords.service';

/**
 * Self-contained: PrismaModule is @Global, and keywords are plain data.
 *
 * It imported CrawlerModule while a per-keyword "run now" endpoint lived here and
 * needed CRAWL_QUEUE. That endpoint is gone — triggering a crawl belongs to the job
 * that knows which site and how deep — so the dependency went with it. The
 * scheduler PULLS Keyword rows at fan-out time rather than this module pushing to
 * it, which is what keeps adding a keyword free of cron churn.
 */
@Module({
  controllers: [KeywordsController],
  providers: [KeywordsService],
  exports: [KeywordsService],
})
export class KeywordsModule {}
