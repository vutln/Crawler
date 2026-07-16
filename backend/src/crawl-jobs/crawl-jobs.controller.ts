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
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CrawlJobsService } from './crawl-jobs.service';
import {
  CreateCrawlJobDto,
  CrawlJobDto,
  CrawlRunDto,
  ListCrawlRunsDto,
  PaginatedCrawlRunsDto,
  UpdateCrawlJobDto,
} from './dto/crawl-job.dto';

@ApiTags('crawl-jobs')
@Controller('crawl-jobs')
export class CrawlJobsController {
  constructor(private readonly jobs: CrawlJobsService) {}

  @Get()
  @ApiOperation({ summary: 'List crawl job definitions' })
  @ApiOkResponse({ type: [CrawlJobDto] })
  findAll(): Promise<CrawlJobDto[]> {
    return this.jobs.findAll();
  }

  @Post()
  @ApiOperation({
    summary: 'Create a crawl job definition',
    description: 'A definition is a template. It produces a CrawlRun each time it fires.',
  })
  @ApiCreatedResponse({ type: CrawlJobDto })
  create(@Body() dto: CreateCrawlJobDto): Promise<CrawlJobDto> {
    return this.jobs.create(dto);
  }

  @Get(':id')
  @ApiOkResponse({ type: CrawlJobDto })
  findOne(@Param('id') id: string): Promise<CrawlJobDto> {
    return this.jobs.findOne(id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: CrawlJobDto })
  update(@Param('id') id: string, @Body() dto: UpdateCrawlJobDto): Promise<CrawlJobDto> {
    return this.jobs.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(@Param('id') id: string): Promise<void> {
    return this.jobs.remove(id);
  }

  @Post(':id/run')
  @ApiOperation({
    summary: 'Trigger a run now',
    description: 'Returns immediately with a QUEUED run; poll GET /crawl-runs/:id for progress.',
  })
  @ApiCreatedResponse({ type: CrawlRunDto })
  trigger(@Param('id') id: string): Promise<CrawlRunDto> {
    return this.jobs.trigger(id);
  }
}

@ApiTags('crawl-runs')
@Controller('crawl-runs')
export class CrawlRunsController {
  constructor(private readonly jobs: CrawlJobsService) {}

  @Get()
  @ApiOperation({ summary: 'List crawl runs (executions)' })
  @ApiOkResponse({ type: PaginatedCrawlRunsDto })
  list(@Query() query: ListCrawlRunsDto): Promise<PaginatedCrawlRunsDto> {
    return this.jobs.listRuns(query);
  }

  @Get(':id')
  @ApiOkResponse({ type: CrawlRunDto })
  findOne(@Param('id') id: string): Promise<CrawlRunDto> {
    return this.jobs.findRun(id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a queued or running crawl' })
  @ApiOkResponse({ type: CrawlRunDto })
  cancel(@Param('id') id: string): Promise<CrawlRunDto> {
    return this.jobs.cancelRun(id);
  }
}
