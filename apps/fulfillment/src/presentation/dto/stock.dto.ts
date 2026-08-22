// The five validated request DTOs (design.md §6.2) — each `implements` its
// generated `@otc/contracts` request payload field-for-field (the
// `OrdersCreateRequestDto` precedent), decorated with `class-validator`.
// Validated manually inside `stock.controller.ts` (not a global
// `ValidationPipe`) so a validation failure becomes an `RpcError`-shaped
// reply under this feature's OWN control.
import 'reflect-metadata';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  StockCheckRequestPayload,
  StockListRequestPayload,
  StockReleaseRequestPayload,
  StockReplenishRequestPayload,
  StockReserveRequestPayload,
} from '@otc/contracts';

const ORDER_REFERENCE_PATTERN = /^ORD-\d{6}$/;
const RELEASE_REASONS = ['credit_rejected', 'order_cancelled'] as const;

export class StockCheckLineDto {
  @IsString()
  productCode!: string;

  @IsInt()
  @IsPositive()
  quantity!: number;
}

export class StockCheckRequestDto implements StockCheckRequestPayload {
  @IsString()
  companyCode!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StockCheckLineDto)
  lines!: [StockCheckLineDto, ...StockCheckLineDto[]];
}

export class StockReserveLineDto {
  @IsString()
  productCode!: string;

  @IsInt()
  @IsPositive()
  units!: number;
}

export class StockReserveRequestDto implements StockReserveRequestPayload {
  @Matches(ORDER_REFERENCE_PATTERN)
  orderReference!: string;

  @IsString()
  retailerCode!: string;

  @IsString()
  companyCode!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StockReserveLineDto)
  lines!: [StockReserveLineDto, ...StockReserveLineDto[]];
}

export class StockReleaseRequestDto implements StockReleaseRequestPayload {
  @Matches(ORDER_REFERENCE_PATTERN)
  orderReference!: string;

  @IsIn(RELEASE_REASONS)
  reason!: 'credit_rejected' | 'order_cancelled';
}

export class StockListRequestDto implements StockListRequestPayload {
  @IsOptional()
  @IsString()
  companyCode?: string;

  @IsOptional()
  @IsString()
  productCode?: string;

  @IsOptional()
  @IsBoolean()
  belowThreshold?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 25;
}

export class StockReplenishLineDto {
  @IsString()
  productCode!: string;

  @IsInt()
  @IsPositive()
  units!: number;
}

export class StockReplenishRequestDto implements StockReplenishRequestPayload {
  @IsString()
  companyCode!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StockReplenishLineDto)
  lines!: [StockReplenishLineDto, ...StockReplenishLineDto[]];
}
