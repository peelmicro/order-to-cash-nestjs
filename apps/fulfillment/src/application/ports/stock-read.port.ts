// The `QueryBus` side (design.md §5.2) — never locks, never mutates. Plain
// SELECTs behind `stock.check`/`stock.list`.
import type { StockCheckReplyPayload, StockListReplyPayload, StockListRequestPayload } from '@otc/contracts';

export const STOCK_READ = Symbol('StockRead');

export interface StockReadPort {
  availability(
    companyCode: string,
    lines: readonly { readonly productCode: string; readonly quantity: number }[],
  ): Promise<StockCheckReplyPayload>;

  list(query: StockListRequestPayload): Promise<StockListReplyPayload>;
}
