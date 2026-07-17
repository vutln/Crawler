import { Module } from '@nestjs/common';
import { KeywordsController } from './keywords.controller';
import { KeywordsService } from './keywords.service';

/**
 * Self-contained: PrismaModule is @Global, and keywords are plain data — nothing
 * here needs the crawler. The scheduler reads Keyword rows at fan-out time rather
 * than this module pushing to it, which is what keeps adding a keyword free of
 * cron churn.
 */
@Module({
  controllers: [KeywordsController],
  providers: [KeywordsService],
  exports: [KeywordsService],
})
export class KeywordsModule {}
