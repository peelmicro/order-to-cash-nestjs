// The two validated request DTOs (design.md §4.2) — each `implements` its
// generated `@otc/contracts` request payload field-for-field (the
// `StockReserveRequestDto` precedent), decorated with `class-validator`.
// Validated manually inside `credit.controller.ts` (not a global
// `ValidationPipe`) so a validation failure becomes an `RpcError`-shaped
// reply under this feature's own control.
import 'reflect-metadata';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min, ValidateNested } from 'class-validator';
import type { CreditHoldRequestPayload, CreditListRequestPayload, Money } from '@otc/contracts';

const ORDER_REFERENCE_PATTERN = /^ORD-\d{6}$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export class MoneyDto implements Money {
  @IsInt()
  amount!: number;

  @Matches(CURRENCY_CODE_PATTERN)
  currency!: string;
}

export class CreditHoldRequestDto implements CreditHoldRequestPayload {
  @Matches(ORDER_REFERENCE_PATTERN)
  orderReference!: string;

  @IsString()
  retailerCode!: string;

  @IsString()
  companyCode!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  amount!: MoneyDto;
}

export class CreditListRequestDto implements CreditListRequestPayload {
  @IsOptional()
  @IsString()
  retailerCode?: string;

  @IsOptional()
  @IsString()
  companyCode?: string;

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
