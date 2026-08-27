// The `orders.cancel` responder (feature 41, `orders_cancel_responder`) —
// same shape as `orders-create.controller.ts`'s own header describes:
// explicit `Transport.NATS` (CLAUDE.md's hybrid-app non-negotiable — a bare
// pattern decorator would also bind to this service's Kafka microservice),
// `@Inject(TOKEN)` DI, never throws (every outcome resolves the method with
// a plain object discriminated by shape, `success` vs `RpcError`, per
// asyncapi.yaml's `ordersCancelReply` channel).
import { Controller, Inject } from '@nestjs/common';
import { Ctx, MessagePattern, NatsContext, Payload, Transport } from '@nestjs/microservices';
import { context as otelContext } from '@opentelemetry/api';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { MsgHdrs } from 'nats';
import type { OrdersCancelReplyPayload, RpcError } from '@otc/contracts';
import { CancelOrderHandler, type CancelOrderResult } from '../application/cancel-order.handler';
import { extractNatsTraceContext } from '../infrastructure/observability/trace-context';
import { OrdersCancelRequestDto } from './dto/orders-cancel.dto';
import { validationRpcError } from './rpc-error-mapper';

export const ORDERS_CANCEL_SUBJECT = 'orders.cancel';

@Controller()
export class OrdersCancelController {
  constructor(@Inject(CancelOrderHandler) private readonly cancelOrder: CancelOrderHandler) {}

  @MessagePattern(ORDERS_CANCEL_SUBJECT, Transport.NATS)
  async cancel(@Payload() payload: unknown, @Ctx() natsContext: NatsContext): Promise<OrdersCancelReplyPayload | RpcError> {
    const extracted = extractNatsTraceContext(natsContext.getHeaders() as MsgHdrs | undefined);
    return otelContext.with(extracted, () => this.handle(payload));
  }

  private async handle(payload: unknown): Promise<OrdersCancelReplyPayload | RpcError> {
    const dto = plainToInstance(OrdersCancelRequestDto, payload ?? {});
    const violations = await validate(dto, { whitelist: true });
    if (violations.length > 0) {
      return validationRpcError(violations);
    }

    const result = await this.cancelOrder.execute({ orderId: dto.orderId, note: dto.note });
    return toReply(result, dto.orderId);
  }
}

function toReply(result: CancelOrderResult, requestedOrderId: string): OrdersCancelReplyPayload | RpcError {
  const occurredAt = new Date().toISOString();

  switch (result.outcome) {
    case 'not_found':
      return { code: 'NOT_FOUND', message: `order ${requestedOrderId} not found`, occurredAt };

    case 'not_cancellable':
      // asyncapi.yaml `requestOrdersCancel`: "From despatched onwards the
      // reply is ORDER_NOT_CANCELLABLE" — a legitimate business rejection
      // (gateway/src/domain/problem/rpc-error-mapping.ts maps this to HTTP
      // 409, never 503).
      return {
        code: 'ORDER_NOT_CANCELLABLE',
        message: `order ${result.orderReference} cannot be cancelled from status "${result.status}"`,
        details: { status: result.status },
        occurredAt,
      };

    case 'compensation_pending':
      return {
        orderId: result.orderId,
        orderReference: result.orderReference,
        status: result.status,
        compensationPlanned: [...result.compensationPlanned],
      };

    case 'cancelled':
      return {
        orderId: result.orderId,
        orderReference: result.orderReference,
        status: result.status,
        cancellationReason: result.cancellationReason,
        compensationPlanned: [],
      };
  }
}
