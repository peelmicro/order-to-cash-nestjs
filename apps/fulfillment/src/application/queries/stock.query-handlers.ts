// Two thin `@QueryHandler` classes (design.md §5.1) — no logic beyond
// delegation, every dependency through `@Inject(TOKEN)` (CLAUDE.md's DI
// rule), registered as class providers in `app.module.ts`.
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import type { StockCheckReplyPayload, StockListReplyPayload } from '@otc/contracts';
import { STOCK_READ, type StockReadPort } from '../ports/stock-read.port.js';
import { CheckStockQuery, ListStockQuery } from './stock.queries.js';

@QueryHandler(CheckStockQuery)
export class CheckStockHandler implements IQueryHandler<CheckStockQuery, StockCheckReplyPayload> {
  constructor(@Inject(STOCK_READ) private readonly stockRead: StockReadPort) {}

  execute(query: CheckStockQuery): Promise<StockCheckReplyPayload> {
    return this.stockRead.availability(query.companyCode, query.lines);
  }
}

@QueryHandler(ListStockQuery)
export class ListStockHandler implements IQueryHandler<ListStockQuery, StockListReplyPayload> {
  constructor(@Inject(STOCK_READ) private readonly stockRead: StockReadPort) {}

  execute(query: ListStockQuery): Promise<StockListReplyPayload> {
    return this.stockRead.list(query.request);
  }
}

/** Every `@QueryHandler` class this module declares — for `app.module.ts`'s class-provider list. */
export const STOCK_QUERY_HANDLERS = [CheckStockHandler, ListStockHandler] as const;
