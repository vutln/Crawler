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

  @ApiPropertyOptional({ description: 'Required for SEARCH jobs' })
  // Conditional rather than blanket-optional: a SEARCH job with no query is
  // invalid, and rejecting it here beats failing deep inside an adapter.
  @ValidateIf((o: CreateCrawlJobDto) => o.type === CrawlJobType.SEARCH)
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  query?: string;

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

  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 1000, type: Number })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  maxItems: number = 100;

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
  @ApiPropertyOptional() @IsString() @MaxLength(191) @IsOptional() query?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsArray() @IsUrl({}, { each: true }) @ArrayMaxSize(500) @IsOptional()
  urls?: string[];
  @ApiPropertyOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) @IsOptional() maxPages?: number;
  @ApiPropertyOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) @IsOptional() maxItems?: number;
  @ApiPropertyOptional({ nullable: true }) @IsString() @IsOptional() cronExpression?: string | null;
  @ApiPropertyOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean() @IsOptional()
  enabled?: boolean;
}

// See ProductDto for why these are @ApiProperty({nullable:true}) and not
// @ApiPropertyOptional: the keys are always present, the values may be null.
export class CrawlJobDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: Marketplace, enumName: 'Marketplace' }) marketplace!: Marketplace;
  @ApiProperty({ enum: CrawlJobType, enumName: 'CrawlJobType' }) type!: CrawlJobType;
  @ApiProperty({ nullable: true, type: String }) query!: string | null;
  @ApiProperty({ type: [String], nullable: true }) urls!: string[] | null;
  @ApiProperty() maxPages!: number;
  @ApiProperty() maxItems!: number;
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
}
