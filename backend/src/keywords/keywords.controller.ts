import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  BulkCreateKeywordsDto,
  BulkCreateKeywordsResultDto,
  CreateKeywordDto,
  KeywordDto,
  UpdateKeywordDto,
} from './dto/keyword.dto';
import { KeywordsService } from './keywords.service';

@ApiTags('keywords')
@Controller('keywords')
export class KeywordsController {
  constructor(private readonly keywords: KeywordsService) {}

  @Get()
  @ApiOperation({
    summary: 'List every tracked keyword',
    description:
      'Keywords are available to KEYWORD_SWEEP jobs. A job with ' +
      'trackAllKeywords=true collects every keyword, including ones added later; ' +
      'otherwise it collects only its selected keywords.',
  })
  @ApiOkResponse({ type: [KeywordDto] })
  findAll(): Promise<KeywordDto[]> {
    return this.keywords.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Add one keyword' })
  @ApiCreatedResponse({ type: KeywordDto })
  @ApiConflictResponse({
    description: 'A keyword with the same normalized text already exists.',
  })
  create(@Body() dto: CreateKeywordDto): Promise<KeywordDto> {
    return this.keywords.create(dto);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Add many keywords at once (paste a list)',
    description:
      'Terms already in the list are SKIPPED, not rejected — pasting 50 keywords of ' +
      'which 3 exist is a success, and the response reports exactly what happened. ' +
      'Text is normalized (trimmed, whitespace collapsed, lowercased) before comparison.',
  })
  @ApiOkResponse({ type: BulkCreateKeywordsResultDto })
  // 200, not 201: this is a report on a partially-applied batch, not a single
  // created resource, and there is no one Location to point at.
  bulkCreate(
    @Body() dto: BulkCreateKeywordsDto,
  ): Promise<BulkCreateKeywordsResultDto> {
    return this.keywords.bulkCreate(dto);
  }

  @Get(':id')
  @ApiOkResponse({ type: KeywordDto })
  findOne(@Param('id') id: string): Promise<KeywordDto> {
    return this.keywords.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Rename a keyword or update its notes',
    description:
      'This does not change which jobs collect the keyword. To stop collecting it ' +
      'on one marketplace, deselect it from that crawl job. Deleting the keyword ' +
      'removes it from every job while preserving products and price history.',
  })
  @ApiOkResponse({ type: KeywordDto })
  @ApiConflictResponse({
    description: 'The new text collides with an existing keyword.',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateKeywordDto,
  ): Promise<KeywordDto> {
    return this.keywords.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a keyword',
    description:
      'Removes the keyword and its product links. Products and their price history are ' +
      'NOT deleted — that series is the point of the project and outlives the search term.',
  })
  @ApiNoContentResponse()
  remove(@Param('id') id: string): Promise<void> {
    return this.keywords.remove(id);
  }
}
