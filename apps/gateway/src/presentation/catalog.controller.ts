// `GET /catalog/products`, `GET /catalog/retailers`, `GET /catalog/companies`
// (openapi.yaml `catalog` tag). See `application/queries/list-catalog.query.ts`
// for the recorded gap (no live `catalog.reference.list` responder yet).
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import type { Product, Party } from '../application/contracts-aliases';
import { ListCatalogQuery } from '../application/queries/list-catalog.query';

@Controller('catalog')
export class CatalogController {
  constructor(@Inject(QueryBus) private readonly queries: QueryBus) {}

  @Get('products')
  async listProducts(@Query('includeDisabled') includeDisabled: string | undefined): Promise<{ items: Product[] }> {
    const reply = await this.queries.execute<ListCatalogQuery, { products?: Product[] }>(
      new ListCatalogQuery('products', includeDisabled === 'true'),
    );
    return { items: reply.products ?? [] };
  }

  @Get('retailers')
  async listRetailers(@Query('includeDisabled') includeDisabled: string | undefined): Promise<{ items: Party[] }> {
    const reply = await this.queries.execute<ListCatalogQuery, { retailers?: Party[] }>(
      new ListCatalogQuery('retailers', includeDisabled === 'true'),
    );
    return { items: reply.retailers ?? [] };
  }

  @Get('companies')
  async listCompanies(@Query('includeDisabled') includeDisabled: string | undefined): Promise<{ items: Party[] }> {
    const reply = await this.queries.execute<ListCatalogQuery, { companies?: Party[] }>(
      new ListCatalogQuery('companies', includeDisabled === 'true'),
    );
    return { items: reply.companies ?? [] };
  }
}
