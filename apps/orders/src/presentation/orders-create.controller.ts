// The `orders.create` responder — `orders_acceptance` "What to build" step
// 2. `@MessagePattern` (NATS, `@nestjs/microservices`), a validated request
// DTO (`orders-create.dto.ts`), delegating to the application-layer
// `PlaceOrderHandler`, replying with the AsyncAPI reply schema
// (`OrdersCreateReplyPayload`) from `@otc/contracts`.
//
// Deliberately NEVER throws. `asyncapi.yaml`'s `ordersCreateReply` channel
// documents `success`/`error` as two alternative PAYLOAD SHAPES on the same
// reply address (NATS core has no separate error channel at the wire
// level) — so every outcome (validation failure, a domain/application
// refusal, a stock-check timeout, an unexpected error) resolves the method
// with a plain object, discriminated by shape (`orderId`+`status` vs
// `code`), never a rejected promise/thrown `RpcException`. That keeps the
// exact `RpcError` shape under this feature's own control instead of
// Nest's default microservices exception handling.
import { Controller, Inject } from '@nestjs/common';
import { MessagePattern, Payload, Transport } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { OrdersCreateReplyPayload, RpcError } from '@otc/contracts';
import { PlaceOrderHandler, type PlaceOrderCommand } from '../application/place-order.handler';
import { OrdersCreateRequestDto } from './dto/orders-create.dto';
import { toRpcError, validationRpcError } from './rpc-error-mapper';

@Controller()
export class OrdersCreateController {
  // Explicit `@Inject(PlaceOrderHandler)`, not bare constructor-parameter
  // typing: `pnpm dev:orders` runs under `tsx` (esbuild), which does not
  // emit `design:paramtypes` decorator metadata, so Nest cannot infer the
  // token from the parameter's TYPE alone at runtime — it silently resolves
  // to `undefined` instead of throwing (`db-config.ts`/`outbox-relay.service.ts`
  // already established this project's `@Inject(TOKEN)` convention for
  // exactly this reason; a plain-class token needs it just as much as a
  // `Symbol` one does).
  constructor(@Inject(PlaceOrderHandler) private readonly placeOrder: PlaceOrderHandler) {}

  // `Transport.NATS` explicit (order_saga_orchestrator, feature 16's live-
  // stack finding, see saga-facts.controller.ts's header comment): without
  // a declared transport, this pattern was also being bound to the KAFKA
  // microservice added by main.ts, and `ServerKafka` tried to
  // `consumer.subscribe()` a Kafka topic literally named "orders.create",
  // crashing the process at boot.
  @MessagePattern('orders.create', Transport.NATS)
  async create(@Payload() payload: unknown): Promise<OrdersCreateReplyPayload | RpcError> {
    const dto = plainToInstance(OrdersCreateRequestDto, payload ?? {});
    const violations = await validate(dto, { whitelist: true, forbidNonWhitelisted: false });
    if (violations.length > 0) {
      return validationRpcError(violations);
    }

    try {
      const result = await this.placeOrder.execute(toCommand(dto));
      return {
        orderId: result.orderId,
        orderReference: result.orderReference,
        status: result.status,
        currency: result.currency,
        initialAmount: result.initialAmount,
        initialDiscount: result.initialDiscount,
        totalAmount: result.totalAmount,
        orderDate: result.orderDate,
      };
    } catch (error) {
      return toRpcError(error);
    }
  }
}

function toCommand(dto: OrdersCreateRequestDto): PlaceOrderCommand {
  return {
    requestId: dto.requestId,
    retailerCode: dto.retailerCode,
    companyCode: dto.companyCode,
    currency: dto.currency,
    lines: dto.lines.map((line) => ({
      productCode: line.productCode,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineDiscount: line.lineDiscount,
    })),
    orderDiscount: dto.orderDiscount,
    notes: dto.notes,
  };
}
