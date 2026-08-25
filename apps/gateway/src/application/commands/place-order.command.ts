// `POST /orders` (openapi.yaml `placeOrder`) → NATS RPC `orders.create`
// (asyncapi.yaml `requestOrdersCreate`, R13). `Idempotency-Key` (if
// supplied) travels as the RPC payload's own `requestId` — the field the
// `orders.create` responder actually dedupes on
// (apps/orders/src/presentation/orders-create.controller.ts); it is NOT
// the same value as the `x-request-id` RPC header, which identifies this
// specific attempt for tracing (R57) and is fresh on every call, retried
// or not.
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { UniqueId } from '@otc/shared-kernel';
import type { OrdersCreateReplyPayload, OrdersCreateRequestPayload } from '@otc/contracts';
import type { PlaceOrderRequest, PlaceOrderResponse } from '@otc/contracts';
import { ISSUED_ORDER_WINDOW, type IssuedOrderWindow } from '../ports/issued-order-window.port';
import { RPC_CLIENT, type RpcClient } from '../ports/rpc-client.port';

export const ORDERS_CREATE_SUBJECT = 'orders.create';

export class PlaceOrderCommand {
  constructor(
    readonly request: PlaceOrderRequest,
    readonly idempotencyKey: string | undefined,
  ) {}
}

@CommandHandler(PlaceOrderCommand)
export class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand, PlaceOrderResponse> {
  constructor(
    @Inject(RPC_CLIENT) private readonly rpc: RpcClient,
    @Inject(ISSUED_ORDER_WINDOW) private readonly issuedOrders: IssuedOrderWindow,
  ) {}

  async execute(command: PlaceOrderCommand): Promise<PlaceOrderResponse> {
    const request = command.request;
    const payload: OrdersCreateRequestPayload = {
      ...(command.idempotencyKey ? { requestId: command.idempotencyKey } : {}),
      retailerCode: request.retailerCode,
      companyCode: request.companyCode,
      currency: request.currency,
      // `lines` is a `minItems: 1` tuple on both sides of the wire — the
      // REST request DTO's own `@ArrayMinSize(1)` (presentation/dto) already
      // guarantees non-emptiness before this handler ever runs, so the cast
      // states a fact `.map` cannot itself prove to the type checker.
      lines: request.lines.map((line) => ({
        productCode: line.productCode,
        quantity: line.quantity,
        ...(line.unitPrice !== undefined ? { unitPrice: line.unitPrice } : {}),
        ...(line.lineDiscount !== undefined ? { lineDiscount: line.lineDiscount } : {}),
      })) as OrdersCreateRequestPayload['lines'],
      ...(request.orderDiscount !== undefined ? { orderDiscount: request.orderDiscount } : {}),
      ...(request.notes !== undefined ? { notes: request.notes } : {}),
    };

    // Neither the order nor its id is known yet — a fresh gateway request
    // id stands in for `x-correlation-id` (asyncapi.yaml `rpcCorrelationId`:
    // "otherwise the gateway request id").
    const requestId = UniqueId.generate().value;
    const reply = await this.rpc.call<OrdersCreateRequestPayload, OrdersCreateReplyPayload>(
      ORDERS_CREATE_SUBJECT,
      payload,
      { correlationId: requestId, requestId },
    );

    // F3 (review) — R55's "an id the caller has just been given" is, by
    // construction, an id THIS gateway just handed out: record it so
    // `GetOrderHandler` can answer 202 (not a false 404) for it right up
    // until the projection catches up or the window's TTL expires.
    this.issuedOrders.record(reply.orderId);

    return {
      orderId: reply.orderId,
      orderReference: reply.orderReference,
      status: 'placed',
      currency: reply.currency,
      initialAmount: reply.initialAmount,
      initialDiscount: reply.initialDiscount,
      totalAmount: reply.totalAmount,
      orderDate: reply.orderDate,
      // R55 — always true at creation: the read model has not seen this
      // order yet, no matter how quickly this HTTP response returns.
      projectionPending: true,
    };
  }
}
