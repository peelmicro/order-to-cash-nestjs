// `GET /credits` (openapi.yaml `billing` tag).
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import type { CreditPage } from '../application/contracts-aliases';
import { ListCreditsQuery } from '../application/queries/list-credits.query';
import { parsePageParams } from './pagination';

@Controller('credits')
export class CreditsController {
  constructor(@Inject(QueryBus) private readonly queries: QueryBus) {}

  @Get()
  async listCredits(
    @Query('retailerCode') retailerCode: string | undefined,
    @Query('companyCode') companyCode: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
  ): Promise<CreditPage> {
    const { page: parsedPage, pageSize: parsedPageSize } = parsePageParams({ page, pageSize });
    return this.queries.execute<ListCreditsQuery, CreditPage>(new ListCreditsQuery({ retailerCode, companyCode, page: parsedPage, pageSize: parsedPageSize }));
  }
}
