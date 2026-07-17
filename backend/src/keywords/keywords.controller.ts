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
  ApiAcceptedResponse,
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
  RunKeywordResultDto,
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
      'The daily sweep runs each ENABLED keyword against all three marketplaces. ' +
      'Adding one here changes what tomorrow collects; no job or cron edit is needed.',
  })
  @ApiOkResponse({ type: [KeywordDto] })
  findAll(): Promise<KeywordDto[]> {
    return this.keywords.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Add one keyword' })
  @ApiCreatedResponse({ type: KeywordDto })
  @ApiConflictResponse({ description: 'A keyword with the same normalized text already exists.' })
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
  bulkCreate(@Body() dto: BulkCreateKeywordsDto): Promise<BulkCreateKeywordsResultDto> {
    return this.keywords.bulkCreate(dto);
  }

  @Post(':id/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Collect this one keyword now, across every enabled sweep',
    description:
      'Queues one run per marketplace and returns immediately — poll /crawl-runs, ' +
      'or filter them by the returned batchId. A marketplace whose sweep already ' +
      'has work outstanding is skipped rather than piled onto, and reported in ' +
      '`skipped`. Runs carry this keywordId, so what they collect is linked exactly ' +
      'as the daily sweep would link it.',
  })
  @ApiAcceptedResponse({ type: RunKeywordResultDto })
  runNow(@Param('id') id: string): Promise<RunKeywordResultDto> {
    return this.keywords.runNow(id);
  }

  @Get(':id')
  @ApiOkResponse({ type: KeywordDto })
  findOne(@Param('id') id: string): Promise<KeywordDto> {
    return this.keywords.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Rename a keyword, or enable/disable it',
    description:
      'Disabling keeps the keyword and its collected links but skips it in the sweep. ' +
      'Prefer it to deletion when you only want to stop collecting.',
  })
  @ApiOkResponse({ type: KeywordDto })
  @ApiConflictResponse({ description: 'The new text collides with an existing keyword.' })
  update(@Param('id') id: string, @Body() dto: UpdateKeywordDto): Promise<KeywordDto> {
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
