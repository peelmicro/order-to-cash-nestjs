// `GET /orders/{id}` (openapi.yaml `getOrder`, R54, R55). Three-way result
// — `found` (200), `pending` (202 projection pending — R55's own clause,
// scoped to "an order identifier that the caller has just been given":
// answered here ONLY when `IssuedOrderWindow` confirms THIS gateway
// itself handed out `orderId` recently), `unknown` (404 — everything
// else: a garbage id, a typo, an id nobody has ever been given). Review
// finding F3: before this fix EVERY miss answered `pending`, making
// openapi.yaml's own documented `404` ("the identifier is unknown to the
// system") unreachable.
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { toOrderDetail, type OrderDetailLike } from '../../domain/projection/order-read-model-mapper';
import { ISSUED_ORDER_WINDOW, type IssuedOrderWindow } from '../ports/issued-order-window.port';
import { ORDER_READ_MODEL, type OrderReadModel } from '../ports/order-read-model.port';

export class GetOrderQuery {
  constructor(readonly orderId: string) {}
}

export type GetOrderResult =
  | { readonly kind: 'found'; readonly detail: OrderDetailLike }
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown' };

@QueryHandler(GetOrderQuery)
export class GetOrderHandler implements IQueryHandler<GetOrderQuery, GetOrderResult> {
  constructor(
    @Inject(ORDER_READ_MODEL) private readonly readModel: OrderReadModel,
    @Inject(ISSUED_ORDER_WINDOW) private readonly issuedOrders: IssuedOrderWindow,
  ) {}

  async execute(query: GetOrderQuery): Promise<GetOrderResult> {
    const doc = await this.readModel.findById(query.orderId);
    if (doc) {
      return { kind: 'found', detail: toOrderDetail(doc) };
    }
    if (this.issuedOrders.isRecentlyIssued(query.orderId)) {
      return { kind: 'pending' };
    }
    return { kind: 'unknown' };
  }
}
