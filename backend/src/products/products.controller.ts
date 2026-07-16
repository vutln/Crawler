import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ListProductsDto } from './dto/list-products.dto';
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
