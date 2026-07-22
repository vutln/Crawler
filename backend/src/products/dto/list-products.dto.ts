import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Marketplace } from '../../generated/prisma/client';

export enum ProductSortBy {
  Title = 'title',
  Price = 'price',
  LastScrapedAt = 'lastScrapedAt',
  FirstSeenAt = 'firstSeenAt',
  Rating = 'rating',
}

export enum SortOrder {
  Asc = 'asc',
  Desc = 'desc',
}

export class ListProductsDto {
  // The `: number` annotations are load-bearing, not style. With a bare
  // initializer (`page = 1`) the Swagger plugin cannot infer the type and emits
  // an empty `Object` schema, which reaches the frontend as
  // `Record<string, never>` and breaks every caller.
  @ApiPropertyOptional({ minimum: 1, default: 1, type: Number })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25, type: Number })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100) // hard ceiling: an unbounded pageSize is a trivial DoS on the DB
  @IsOptional()
  pageSize: number = 25;

  @ApiPropertyOptional({ description: 'Substring match on title' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ enum: Marketplace, enumName: 'Marketplace' })
  @IsEnum(Marketplace)
  @IsOptional()
  marketplace?: Marketplace;

  @ApiPropertyOptional({ description: 'Filter on latest known price' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  minPrice?: number;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxPrice?: number;

  @ApiPropertyOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  @IsOptional()
  inStock?: boolean;

  /**
   * Only products this keyword surfaced, on any marketplace.
   *
   * Not validated against the Keyword table on purpose: an unknown id simply
   * matches nothing, which degrades to an empty list rather than a 400. A
   * hand-edited URL should show "no results", not an error page.
   */
  @ApiPropertyOptional({
    description: 'Only products surfaced by this keyword',
  })
  @IsString()
  @IsOptional()
  keywordId?: string;

  @ApiPropertyOptional({
    enum: ProductSortBy,
    enumName: 'ProductSortBy',
    default: ProductSortBy.LastScrapedAt,
  })
  @IsEnum(ProductSortBy)
  @IsOptional()
  sortBy: ProductSortBy = ProductSortBy.LastScrapedAt;

  @ApiPropertyOptional({
    enum: SortOrder,
    enumName: 'SortOrder',
    default: SortOrder.Desc,
  })
  @IsEnum(SortOrder)
  @IsOptional()
  sortOrder: SortOrder = SortOrder.Desc;
}

/**
 * Everything list() filters on, minus paging.
 *
 * OmitType from @nestjs/swagger (already a dependency — no new package) so the
 * export inherits every current AND future filter for free. Hand-copying the
 * fields is how the CSV and the screen start disagreeing about what "the current
 * filter" means.
 *
 * page/pageSize are dropped deliberately: "export what I filtered" is the whole
 * expectation, and exporting only the page the user happens to be on is the most
 * common way this feature is built wrong.
 */
export class ExportProductsDto extends OmitType(ListProductsDto, [
  'page',
  'pageSize',
] as const) {}

/** What buildWhere() needs — satisfied by both the list and the export DTOs. */
export type ProductFilters = Omit<
  ListProductsDto,
  'page' | 'pageSize' | 'sortBy' | 'sortOrder'
>;
