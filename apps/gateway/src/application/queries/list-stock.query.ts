// `GET /stock` (openapi.yaml `listStock`) → NATS RPC `fulfillment.stock.list`
// (asyncapi.yaml `requestStockList`) — "a live read of the Fulfillment
// write model, not the read model: stock is not part of an order's
// timeline" (openapi.yaml's own words). This is the ONE list endpoint the
// contract itself says is NOT R54's read-model rule.
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { UniqueId } from '@otc/shared-kernel';
import type { StockListReplyPayload, StockListRequestPayload } from '@otc/contracts';
import type { StockPage } from '../contracts-aliases';
import { RPC_CLIENT, type RpcClient } from '../ports/rpc-client.port';

export const STOCK_LIST_SUBJECT = 'fulfillment.stock.list';

export class ListStockQuery {
  constructor(readonly request: StockListRequestPayload) {}
}

@QueryHandler(ListStockQuery)
export class ListStockHandler implements IQueryHandler<ListStockQuery, StockPage> {
  constructor(@Inject(RPC_CLIENT) private readonly rpc: RpcClient) {}

  async execute(query: ListStockQuery): Promise<StockPage> {
    const requestId = UniqueId.generate().value;
    return this.rpc.call<StockListRequestPayload, StockListReplyPayload>(STOCK_LIST_SUBJECT, query.request, {
      correlationId: requestId,
      requestId,
    });
  }
}
