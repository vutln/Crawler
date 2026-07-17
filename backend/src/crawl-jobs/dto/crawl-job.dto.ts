import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  CrawlJobType,
  Marketplace,
  RunStatus,
  RunTrigger,
} from '../../generated/prisma/client';

export class CreateCrawlJobDto {
  @ApiProperty({ example: 'Mechanical keyboards on eBay' })
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  name!: string;

  @ApiProperty({ enum: Marketplace, enumName: 'Marketplace' })
  @IsEnum(Marketplace)
  marketplace!: Marketplace;

  @ApiProperty({ enum: CrawlJobType, enumName: 'CrawlJobType' })
  @IsEnum(CrawlJobType)
  type!: CrawlJobType;

  // `query` is gone: what to search for lives in Keyword, and a KEYWORD_SWEEP job
  // reads it from there. A per-job query used to produce runs with no keywordId,
  // whose products no keyword pointed at — see the CrawlJobType comment in
  // schema.prisma.

  @ApiPropertyOptional({
    default: true,
    description:
      'true = collect every keyword, including ones added later. ' +
      'false = collect only `keywordIds`.',
  })
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  @IsOptional()
  trackAllKeywords: boolean = true;

  /**
   * The explicit selection. Ignored when trackAllKeywords is true — sending both is
   * not an error, it just means the list is stored and unused until you turn the
   * flag off.
   */
  @ApiPropertyOptional({ type: [String], description: 'Required when trackAllKeywords is false' })
  @ValidateIf((o: CreateCrawlJobDto) => o.trackAllKeywords === false)
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @IsOptional()
  keywordIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Required for PRODUCT_URLS jobs' })
  @ValidateIf((o: CreateCrawlJobDto) => o.type === CrawlJobType.PRODUCT_URLS)
  @IsArray()
  @ArrayMaxSize(500)
  @IsUrl({}, { each: true })
  urls?: string[];

  @ApiPropertyOptional({ default: 3, minimum: 1, maximum: 20, type: Number })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20) // politeness ceiling — deep pagination is what gets you blocked
  @IsOptional()
  maxPages: number = 3;

  /**
   * null = bounded only by maxPages.
   *
   * Worth setting null whenever maxPages > 1: eBay serves 60 results per page, so
   * the old default of 100 silently truncated the second page part-way through and
   * the run reported nothing unusual.
   */
  @ApiPropertyOptional({
    default: null,
    minimum: 1,
    maximum: 1000,
    type: Number,
    nullable: true,
    description: 'Hard cap on items collected. null = bounded only by maxPages.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  maxItems: number | null = null;

  @ApiPropertyOptional({
    description: 'Standard 5/6-field cron. Omit for manual-only. Example: "0 0 6 * * *" = daily 06:00',
    example: '0 0 6 * * *',
  })
  @IsString()
  @IsOptional()
  cronExpression?: string;

  @ApiPropertyOptional({ default: true, type: Boolean })
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  @IsOptional()
  enabled: boolean = true;
}

export class UpdateCrawlJobDto {
  @ApiPropertyOptional() @IsString() @MaxLength(191) @IsOptional() name?: string;
  @ApiPropertyOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean() @IsOptional()
  trackAllKeywords?: boolean;
  /** Replaces the selection wholesale — send the full list, not a delta. */
  @ApiPropertyOptional({ type: [String] })
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) @IsOptional()
  keywordIds?: string[];
  @ApiPropertyOptional({ type: [String] })
  @IsArray() @IsUrl({}, { each: true }) @ArrayMaxSize(500) @IsOptional()
  urls?: string[];
  @ApiPropertyOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) @IsOptional() maxPages?: number;
  /// null clears the cap (bounded only by maxPages). @IsOptional() skips the
  /// validators for null as well as undefined, which is what makes that expressible.
  @ApiPropertyOptional({ nullable: true })
  @Type(() => Number) @IsInt() @Min(1) @Max(1000) @IsOptional()
  maxItems?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsString() @IsOptional() cronExpression?: string | null;
  @ApiPropertyOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean() @IsOptional()
  enabled?: boolean;
}

/** Just enough of a Keyword to say what a job collects, without a second fetch. */
export class KeywordRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() text!: string;
}

// See ProductDto for why these are @ApiProperty({nullable:true}) and not
// @ApiPropertyOptional: the keys are always present, the values may be null.
export class CrawlJobDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: Marketplace, enumName: 'Marketplace' }) marketplace!: Marketplace;
  @ApiProperty({ enum: CrawlJobType, enumName: 'CrawlJobType' }) type!: CrawlJobType;
  @ApiProperty({ type: [String], nullable: true }) urls!: string[] | null;
  @ApiProperty({ description: 'true = every keyword, including ones added later' })
  trackAllKeywords!: boolean;
  /**
   * The job's explicit selection. EMPTY when trackAllKeywords is true — read the
   * flag first, or you will render "0 keywords" for a job that collects them all.
   */
  @ApiProperty({ type: [KeywordRefDto] }) keywords!: KeywordRefDto[];
  @ApiProperty() maxPages!: number;
  @ApiProperty({ nullable: true, type: Number }) maxItems!: number | null;
  @ApiProperty({ nullable: true, type: String }) cronExpression!: string | null;
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: () => CrawlRunDto, description: 'Most recent run, if any' })
  lastRun!: CrawlRunDto | null;
}

export class CrawlRunDto {
  @ApiProperty() id!: string;
  @ApiProperty() jobId!: string;
  @ApiProperty({ description: 'Denormalized for display' }) jobName!: string;
  @ApiProperty({ enum: Marketplace, enumName: 'Marketplace' }) marketplace!: Marketplace;
  /**
   * The keyword this run collected. Null only for PRODUCT_URLS runs, which
   * re-check a fixed URL list and have no search term.
   */
  @ApiProperty({ nullable: true, type: String }) keyword!: string | null;
  /**
   * Groups the runs one sweep produced. Without it a 20-keyword sweep is 20
   * undifferentiated rows in a list paginated at 25.
   */
  @ApiProperty({ nullable: true, type: String }) batchId!: string | null;
  @ApiProperty({ enum: RunStatus, enumName: 'RunStatus' }) status!: RunStatus;
  @ApiProperty({ enum: RunTrigger, enumName: 'RunTrigger' }) trigger!: RunTrigger;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) startedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) finishedAt!: string | null;
  @ApiProperty() itemsFound!: number;
  @ApiProperty() itemsNew!: number;
  @ApiProperty() itemsUpdated!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Failure reason, or the anti-bot evidence when status is BLOCKED',
  })
  error!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Milliseconds; null while running',
  })
  durationMs!: number | null;
}

export class PaginatedCrawlRunsDto {
  @ApiProperty({ type: [CrawlRunDto] }) items!: CrawlRunDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class ListCrawlRunsDto {
  // Explicit `: number` — see ListProductsDto for why a bare initializer
  // produces a useless `Object` schema.
  @ApiPropertyOptional({ default: 1, type: Number })
  @Type(() => Number) @IsInt() @Min(1) @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({ default: 25, maximum: 100, type: Number })
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional()
  pageSize: number = 25;

  @ApiPropertyOptional({ enum: RunStatus, enumName: 'RunStatus' })
  @IsEnum(RunStatus) @IsOptional()
  status?: RunStatus;

  @ApiPropertyOptional({ enum: Marketplace, enumName: 'Marketplace' })
  @IsEnum(Marketplace) @IsOptional()
  marketplace?: Marketplace;

  @ApiPropertyOptional() @IsString() @IsOptional() jobId?: string;

  /** "Show me every run that collected this keyword" — across all marketplaces. */
  @ApiPropertyOptional() @IsString() @IsOptional() keywordId?: string;

  /** "Show me one sweep" — the N runs a single cron fire produced. */
  @ApiPropertyOptional() @IsString() @IsOptional() batchId?: string;
}
