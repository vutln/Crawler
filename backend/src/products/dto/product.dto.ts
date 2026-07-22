import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Marketplace } from '../../generated/prisma/client';

/**
 * Wire shape for a product.
 *
 * Every field is explicitly decorated rather than relying on the Swagger CLI
 * plugin alone, because these types are the frontend's source of truth: they get
 * codegen'd into src/api/generated/schema.d.ts. A field missing here becomes a
 * field the frontend cannot see.
 */
// Note on @ApiProperty({ nullable: true }) vs @ApiPropertyOptional below.
// They are NOT interchangeable:
//   ApiPropertyOptional          -> the key may be ABSENT  -> `field?: T` (adds undefined)
//   ApiProperty({nullable:true}) -> the key is always PRESENT, value may be null -> `field: T | null`
// ProductsService.toDto always sets every key, so these are required-and-nullable.
// Using Optional here would leak a phantom `undefined` into every frontend call
// site and force null-checks for a state that cannot occur.
export class ProductDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: Marketplace, enumName: 'Marketplace' })
  marketplace!: Marketplace;
  @ApiProperty({ description: 'ASIN / Etsy listing id / eBay item id' })
  externalId!: string;
  @ApiProperty() url!: string;
  @ApiProperty() title!: string;

  @ApiProperty({ nullable: true, type: String }) brand!: string | null;
  @ApiProperty({ nullable: true, type: String }) seller!: string | null;
  @ApiProperty({ nullable: true, type: String }) imageUrl!: string | null;

  @ApiProperty({ example: 'USD' }) currency!: string;

  @ApiProperty({ nullable: true, type: Number, description: '0–5' })
  rating!: number | null;

  @ApiProperty({ nullable: true, type: Number }) reviewCount!: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Most recent observed price. null = no price recorded.',
  })
  currentPrice!: number | null;

  @ApiProperty({ description: 'Stock state at the latest snapshot' })
  inStock!: boolean;

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'Percent change vs the oldest snapshot in the last 7 days. null = insufficient history.',
  })
  priceChange7d!: number | null;

  @ApiProperty({ description: 'Number of price observations recorded' })
  snapshotCount!: number;

  @ApiProperty({ format: 'date-time' }) firstSeenAt!: string;
  @ApiProperty({ format: 'date-time' }) lastScrapedAt!: string;
}

export class PaginatedProductsDto {
  @ApiProperty({ type: [ProductDto] }) items!: ProductDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class PricePointDto {
  @ApiProperty({ format: 'date-time' }) capturedAt!: string;
  @ApiProperty({ nullable: true, type: Number }) price!: number | null;
  @ApiProperty() currency!: string;
  @ApiProperty() inStock!: boolean;
}

export enum PriceHistoryInterval {
  Raw = 'raw',
  Hour = 'hour',
  Day = 'day',
}
