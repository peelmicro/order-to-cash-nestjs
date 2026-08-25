// R54 — the ONLY door onto the order read model. Backed, in production, by
// a DIRECT (read-only) MongoDB read against the projector's `order_timeline`
// collection (infrastructure/persistence/mongo-order-read-model.adapter.ts)
// — no RPC hop, because the projector answers no query subject and the
// contract is explicit that list/detail come from the read model, never a
// write model and never a cross-context join.
import type { OrderTimelineDocumentLike } from '../../domain/projection/order-read-model-mapper';

export const ORDER_READ_MODEL = Symbol('OrderReadModel');

export interface OrderListFilter {
  readonly status?: readonly string[];
  readonly retailerCode?: string;
  readonly companyCode?: string;
  readonly orderReference?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface OrderListResult {
  readonly items: readonly OrderTimelineDocumentLike[];
  readonly total: number;
}

export interface OrderReadModel {
  findById(orderId: string): Promise<OrderTimelineDocumentLike | null>;
  /** Feature 25's own correlationId-resolution step (openapi.yaml `POST /invoices/{id}/payments`): the read model's `_id` IS the order id, reachable here by the business `orderReference` Billing's reply carries. */
  findByOrderReference(orderReference: string): Promise<OrderTimelineDocumentLike | null>;
  list(filter: OrderListFilter): Promise<OrderListResult>;
}
