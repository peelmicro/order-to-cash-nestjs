// The validated request DTO for `orders.cancel` (asyncapi.yaml
// `OrdersCancelRequestPayload`) — same "class-validator, validated manually
// inside the controller" discipline as `orders-create.dto.ts`'s own header
// comment. `orderId` is required HERE even though the wire schema marks
// neither `orderId` nor `orderReference` required (only `reason` is): the
// Gateway — the ONLY caller (`apps/gateway/src/application/commands/cancel-order.command.ts`)
// — always sends `orderId` as the RPC's own `x-correlation-id`, and this
// responder has no other way to locate the order.
import 'reflect-metadata';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import type { OrdersCancelRequestPayload } from '@otc/contracts';

export class OrdersCancelRequestDto implements Partial<OrdersCancelRequestPayload> {
  @IsUUID('4')
  orderId!: string;

  @IsIn(['operator_cancelled'])
  reason!: 'operator_cancelled';

  @IsOptional()
  @IsString()
  note?: string;
}
