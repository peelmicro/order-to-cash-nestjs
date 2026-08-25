// `POST /orders/{id}/cancel` (openapi.yaml `cancelOrder`) → NATS RPC
// `orders.cancel` (asyncapi.yaml `requestOrdersCancel`, R8, R27/R28). The
// order id IS known here, so it — not a fresh gateway request id — is the
// RPC `x-correlation-id` (asyncapi.yaml `rpcCorrelationId`), matching every
// fact this order's saga has produced or will produce.
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { UniqueId } from '@otc/shared-kernel';
import type { OrdersCancelReplyPayload, OrdersCancelRequestPayload } from '@otc/contracts';
import type { CancelOrderResponse } from '../contracts-aliases';
import { RPC_CLIENT, type RpcClient } from '../ports/rpc-client.port';

export const ORDERS_CANCEL_SUBJECT = 'orders.cancel';

export class CancelOrderCommand {
  constructor(
    readonly orderId: string,
    readonly note: string | undefined,
  ) {}
}

@CommandHandler(CancelOrderCommand)
export class CancelOrderHandler implements ICommandHandler<CancelOrderCommand, CancelOrderResponse> {
  constructor(@Inject(RPC_CLIENT) private readonly rpc: RpcClient) {}

  async execute(command: CancelOrderCommand): Promise<CancelOrderResponse> {
    const payload: OrdersCancelRequestPayload = {
      orderId: command.orderId,
      reason: 'operator_cancelled',
      ...(command.note !== undefined ? { note: command.note } : {}),
    };

    const reply = await this.rpc.call<OrdersCancelRequestPayload, OrdersCancelReplyPayload>(
      ORDERS_CANCEL_SUBJECT,
      payload,
      { correlationId: command.orderId, requestId: UniqueId.generate().value },
    );

    return {
      orderId: reply.orderId,
      orderReference: reply.orderReference,
      status: reply.status,
      cancellationReason: 'operator_cancelled',
      compensationPlanned: reply.compensationPlanned ?? [],
    };
  }
}
