import { Module } from '@nestjs/common';
import { CrawlerModule } from '../crawler/crawler.module';
import { KeywordsController } from './keywords.controller';
import { KeywordsService } from './keywords.service';

/**
 * Keywords are plain data, so CRUD needs nothing but the @Global PrismaModule —
 * the scheduler PULLS Keyword rows at fan-out time rather than this module pushing
 * to it, which is what keeps adding a keyword free of cron churn.
 *
 * CrawlerModule is imported for one reason: runNow() enqueues ad-hoc runs, and
 * CRAWL_QUEUE lives there.
 */
@Module({
  imports: [CrawlerModule],
  controllers: [KeywordsController],
  providers: [KeywordsService],
  exports: [KeywordsService],
})
export class KeywordsModule {}
