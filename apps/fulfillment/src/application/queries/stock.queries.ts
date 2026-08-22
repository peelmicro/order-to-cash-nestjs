// The `QueryBus` side (design.md §5.1) — `stock.check`/`stock.list`, never
// locking, never mutating.
import { Query } from '@nestjs/cqrs';
import type { StockCheckReplyPayload, StockListReplyPayload, StockListRequestPayload } from '@otc/contracts';

export class CheckStockQuery extends Query<StockCheckReplyPayload> {
  constructor(
    readonly companyCode: string,
    readonly lines: readonly { readonly productCode: string; readonly quantity: number }[],
  ) {
    super();
  }
}

export class ListStockQuery extends Query<StockListReplyPayload> {
  constructor(readonly request: StockListRequestPayload) {
    super();
  }
}
