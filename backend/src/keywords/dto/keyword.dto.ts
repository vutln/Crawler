import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Marketplace } from '../../generated/prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * 191 everywhere, matching Keyword.text's @db.VarChar(191).
 *
 * 191 rather than 255 is a utf8mb4 constraint, not an arbitrary pick: 191 * 4
 * bytes is the largest value that still fits MySQL's index key limit, which the
 * @unique on text needs.
 */
const MAX_KEYWORD_LENGTH = 191;

export class CreateKeywordDto {
  @ApiProperty({ example: 'mechanical keyboard', maxLength: MAX_KEYWORD_LENGTH })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_KEYWORD_LENGTH)
  text!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @IsOptional()
  notes?: string | null;
}

/**
 * Bulk create — the "paste a list" path, which is the config screen's whole point.
 *
 * Separate from POST /keywords rather than making that endpoint accept an array:
 * the two have genuinely different semantics. Creating one keyword that already
 * exists is a client error (409). Pasting 50 keywords of which 3 already exist is
 * a normal, successful outcome — the user does not want the other 47 rejected
 * because of it. That difference is why this returns a report instead of a row.
 */
export class BulkCreateKeywordsDto {
  @ApiProperty({
    type: [String],
    example: ['mechanical keyboard', 'harry potter shirt', 'vintage film camera'],
    description: 'Normalized and de-duplicated server-side; order is preserved.',
  })
  @IsArray()
  @ArrayMinSize(1)
  // A paste, not an import. Well past any realistic keyword list, and low enough
  // that one request cannot try to enqueue an unbounded daily sweep.
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(MAX_KEYWORD_LENGTH, { each: true })
  keywords!: string[];
}

export class KeywordDto {
  @ApiProperty() id!: string;
  @ApiProperty() text!: string;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty() createdAt!: string;
  /** How many products this keyword has surfaced, across every marketplace. */
  @ApiProperty() productCount!: number;
}

export class UpdateKeywordDto {
  @ApiPropertyOptional({ maxLength: MAX_KEYWORD_LENGTH })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_KEYWORD_LENGTH)
  @IsOptional()
  text?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @IsOptional()
  notes?: string | null;
}

/** What a paste actually did. `skipped` is expected, not an error — see BulkCreateKeywordsDto. */
export class BulkCreateKeywordsResultDto {
  @ApiProperty({ type: [KeywordDto] }) created!: KeywordDto[];
  @ApiProperty({
    type: [String],
    description: 'Submitted terms already in the list, after normalization.',
  })
  skipped!: string[];
  @ApiProperty({
    type: [String],
    description: 'Terms that collapsed to a duplicate of another term in the same paste.',
  })
  duplicates!: string[];
}
