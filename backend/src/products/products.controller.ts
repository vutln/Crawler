import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ExportProductsDto, ListProductsDto } from './dto/list-products.dto';
import {
  PaginatedProductsDto,
  PriceHistoryInterval,
  PricePointDto,
  ProductDto,
} from './dto/product.dto';
import { ProductsService } from './products.service';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @ApiOperation({ summary: 'List collected products (paginated, filterable, sortable)' })
  @ApiOkResponse({ type: PaginatedProductsDto })
  list(@Query() query: ListProductsDto): Promise<PaginatedProductsDto> {
    return this.products.list(query);
  }

  /**
   * MUST stay above @Get(':id') — Nest matches routes in declaration order, so
   * below it this path is swallowed as a product with the id "export.csv".
   */
  @Get('export.csv')
  @ApiOperation({
    summary: 'Export the current product filter as CSV',
    description:
      'Takes the same filters as GET /products, minus paging: you get everything ' +
      'matching, not the page you happen to be on. Streamed, so an export of any ' +
      'size holds constant memory.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'CSV file (UTF-8 with BOM, CRLF)' })
  async exportCsv(@Query() query: ExportProductsDto, @Res() res: Response): Promise<void> {
    // @Res() opts out of Nest's response handling — necessary here because the
    // service writes to the socket incrementally rather than returning a value.
    // The only @Res in the codebase; everything else should keep returning DTOs.
    const filename = `products-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Without this the browser cannot read the filename cross-origin (i.e. when
    // VITE_API_BASE_URL is set in prod). Dev is same-origin via the Vite proxy, so
    // its absence would only ever break in production.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    await this.products.streamCsv(query, res);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one product' })
  @ApiOkResponse({ type: ProductDto })
  findOne(@Param('id') id: string): Promise<ProductDto> {
    return this.products.findOne(id);
  }

  @Get(':id/price-history')
  @ApiOperation({
    summary: 'Price history time series',
    description:
      'The point of the collector. Use interval=hour|day to bucket server-side ' +
      'for long ranges; raw returns every snapshot.',
  })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'ISO date-time' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'ISO date-time' })
  @ApiQuery({ name: 'interval', required: false, enum: PriceHistoryInterval })
  @ApiOkResponse({ type: [PricePointDto] })
  priceHistory(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('interval') interval?: PriceHistoryInterval,
  ): Promise<PricePointDto[]> {
    return this.products.priceHistory(id, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      interval,
    });
  }
}
