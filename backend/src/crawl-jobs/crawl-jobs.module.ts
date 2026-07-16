import { Module } from '@nestjs/common';
import { CrawlerModule } from '../crawler/crawler.module';
import { CrawlJobsController, CrawlRunsController } from './crawl-jobs.controller';
import { CrawlJobsService } from './crawl-jobs.service';

@Module({
  imports: [CrawlerModule],
  controllers: [CrawlJobsController, CrawlRunsController],
  providers: [CrawlJobsService],
})
export class CrawlJobsModule {}
