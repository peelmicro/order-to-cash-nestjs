// `GET /stock`, `POST /stock/replenish` (openapi.yaml `fulfillment` tag).
import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { ReplenishStockCommand } from '../application/commands/replenish-stock.command';
import type { ReplenishStockResponse, StockPage } from '../application/contracts-aliases';
import { ListStockQuery } from '../application/queries/list-stock.query';
import { ReplenishStockRequestDto } from './dto/replenish-stock.dto';
import { parsePageParams } from './pagination';

@Controller('stock')
export class StockController {
  constructor(
    @Inject(CommandBus) private readonly commands: CommandBus,
    @Inject(QueryBus) private readonly queries: QueryBus,
  ) {}

  @Get()
  async listStock(
    @Query('companyCode') companyCode: string | undefined,
    @Query('productCode') productCode: string | undefined,
    @Query('belowThreshold') belowThreshold: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
  ): Promise<StockPage> {
    const { page: parsedPage, pageSize: parsedPageSize } = parsePageParams({ page, pageSize });
    return this.queries.execute<ListStockQuery, StockPage>(
      new ListStockQuery({
        companyCode,
        productCode,
        belowThreshold: belowThreshold === 'true',
        page: parsedPage,
        pageSize: parsedPageSize,
      }),
    );
  }

  @Post('replenish')
  @HttpCode(200)
  async replenish(@Body() dto: ReplenishStockRequestDto): Promise<ReplenishStockResponse> {
    // `lines` is a `minItems: 1` tuple on the wire; `@ArrayMinSize(1)`
    // already guarantees non-emptiness before this handler runs (see
    // place-order.command.ts's identical note).
    return this.commands.execute<ReplenishStockCommand, ReplenishStockResponse>(
      new ReplenishStockCommand(dto as unknown as ConstructorParameters<typeof ReplenishStockCommand>[0]),
    );
  }
}
