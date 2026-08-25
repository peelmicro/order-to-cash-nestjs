// `GET /orders` (openapi.yaml `listOrders`, R54) — served EXCLUSIVELY from
// the projected read model. No RPC call, no write-model client anywhere in
// this file.
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { toOrderSummary } from '../../domain/projection/order-read-model-mapper';
import type { OrderSummaryPage } from '../contracts-aliases';
import { ORDER_READ_MODEL, type OrderListFilter, type OrderReadModel } from '../ports/order-read-model.port';

export class ListOrdersQuery {
  constructor(readonly filter: OrderListFilter) {}
}

@QueryHandler(ListOrdersQuery)
export class ListOrdersHandler implements IQueryHandler<ListOrdersQuery, OrderSummaryPage> {
  constructor(@Inject(ORDER_READ_MODEL) private readonly readModel: OrderReadModel) {}

  async execute(query: ListOrdersQuery): Promise<OrderSummaryPage> {
    const result = await this.readModel.list(query.filter);
    return {
      // R53 — a placeholder document (no orderReference yet) is filtered
      // out of the list rather than emitted half-filled; it stays fully
      // reachable via `GET /orders/{id}`.
      items: result.items.map(toOrderSummary).filter((summary) => summary !== null),
      page: { page: query.filter.page, pageSize: query.filter.pageSize, total: result.total },
    };
  }
}
