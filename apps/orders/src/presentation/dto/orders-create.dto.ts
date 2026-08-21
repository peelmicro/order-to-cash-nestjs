// The validated request DTO for `orders.create` — matches
// `@otc/contracts`'s generated `OrdersCreateRequestPayload` field-for-field
// (`implements` below is a compile-time guarantee of that), decorated with
// `class-validator` per CLAUDE.md's own description of the presentation
// layer ("@MessagePattern NATS ..., DTOs, class-validator").
//
// Validated manually inside `orders-create.controller.ts` (not via a global
// `ValidationPipe`) so a validation failure becomes an `RpcError`-shaped
// reply object under this feature's OWN control, rather than whatever shape
// Nest's default microservices exception handling produces — see
// `rpc-error-mapper.ts`.
// Decorator metadata (`@Type`, `@ValidateNested`) needs `Reflect.getMetadata`
// registered before this module's decorators run. `main.ts` already imports
// this first for the whole app; a spec file that imports this DTO in
// isolation (no `main.ts` in its module graph) would otherwise fail the
// same way — importing it here makes the module self-contained.
import 'reflect-metadata';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import type { OrdersCreateRequestPayload } from '@otc/contracts';

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export class OrdersCreateLineDto {
  @IsString()
  productCode!: string;

  @IsInt()
  @IsPositive()
  quantity!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  lineDiscount?: number;
}

export class OrdersCreateRequestDto implements OrdersCreateRequestPayload {
  @IsOptional()
  @IsUUID('4')
  requestId?: string;

  @IsString()
  retailerCode!: string;

  @IsString()
  companyCode!: string;

  @Matches(CURRENCY_CODE_PATTERN)
  currency!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrdersCreateLineDto)
  lines!: [OrdersCreateLineDto, ...OrdersCreateLineDto[]];

  @IsOptional()
  @IsInt()
  @Min(0)
  orderDiscount?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
