// The one validated request DTO of this feature — `implements` its
// generated `@otc/contracts` request payload field-for-field, the same
// `StockReserveRequestDto` precedent (`presentation/dto/stock.dto.ts`).
// Validated manually inside `despatch.controller.ts`, not a global
// `ValidationPipe`, so a validation failure becomes an `RpcError`-shaped
// reply under this feature's own control.
import 'reflect-metadata';
import { Matches } from 'class-validator';
import type { DespatchCreateRequestPayload } from '@otc/contracts';

const ORDER_REFERENCE_PATTERN = /^ORD-\d{6}$/;

export class DespatchCreateRequestDto implements DespatchCreateRequestPayload {
  @Matches(ORDER_REFERENCE_PATTERN)
  orderReference!: string;
}
