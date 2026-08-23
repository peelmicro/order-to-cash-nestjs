// The two validated request DTOs (design.md §4.2) — each `implements` its
// generated `@otc/contracts` request payload field-for-field (the
// `CreditHoldRequestDto` precedent), decorated with `class-validator`.
// Validated manually inside `invoice.controller.ts` (not a global
// `ValidationPipe`) so a validation failure becomes an `RpcError`-shaped
// reply under this feature's own control (`BI2`).
import 'reflect-metadata';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  registerDecorator,
  ValidateNested,
  type ValidationArguments,
  type ValidationOptions,
  type ValidatorConstraintInterface,
  ValidatorConstraint,
} from 'class-validator';
import type { InvoiceLine, InvoiceListRequestPayload, InvoiceIssueRequestPayload, InvoiceStatus } from '@otc/contracts';

const ORDER_REFERENCE_PATTERN = /^ORD-\d{6}$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const INVOICE_STATUSES: readonly InvoiceStatus[] = ['issued', 'paid'];

export class InvoiceLineDto implements InvoiceLine {
  @IsString()
  productCode!: string;

  @IsInt()
  @Min(1)
  units!: number;

  @IsInt()
  @Min(0)
  unitPrice!: number;
}

/**
 * `BI2` (requirements.md §2.1): "a discount that exceeds the computed
 * amount" is one of the payload cases that SHALL answer VALIDATION_FAILED
 * BEFORE opening any transaction — reviewer finding N2. Runs inside the
 * SAME `validate(dto, ...)` call `invoice.controller.ts` already performs
 * before it ever dispatches `IssueInvoiceCommand`, so a request this
 * rejects never opens `UnitOfWork.execute`, never takes the `credits` row
 * lock and never reaches `invoiceNumbers.next(tx)` — the global counter
 * row design §5.4 argues must be taken last and held as briefly as
 * possible. A cross-field check (`discount` against `Σ unitPrice × units`
 * over `lines`) cannot be expressed with a single-property decorator, so
 * this is a `class-validator` custom constraint rather than a builtin.
 */
@ValidatorConstraint({ name: 'discountWithinComputedAmount', async: false })
class DiscountWithinComputedAmountConstraint implements ValidatorConstraintInterface {
  validate(discount: unknown, args: ValidationArguments): boolean {
    if (discount === undefined || discount === null) {
      return true; // @IsOptional's job; nothing to compare against.
    }
    if (typeof discount !== 'number' || !Number.isFinite(discount)) {
      return true; // @IsInt already reports the wrong-type case.
    }
    const dto = args.object as { lines?: unknown };
    if (!Array.isArray(dto.lines)) {
      return true; // the lines-array checks report a malformed `lines`.
    }
    const amount = dto.lines.reduce((sum: number, line: unknown) => {
      const l = line as { unitPrice?: unknown; units?: unknown };
      const unitPrice = typeof l?.unitPrice === 'number' ? l.unitPrice : 0;
      const units = typeof l?.units === 'number' ? l.units : 0;
      return sum + unitPrice * units;
    }, 0);
    return discount <= amount;
  }

  defaultMessage(): string {
    return 'discount must not exceed the computed amount (Σ unitPrice × units over lines)';
  }
}

function DiscountWithinComputedAmount(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: DiscountWithinComputedAmountConstraint,
    });
  };
}

export class InvoiceIssueRequestDto implements InvoiceIssueRequestPayload {
  @Matches(ORDER_REFERENCE_PATTERN)
  orderReference!: string;

  @IsString()
  retailerCode!: string;

  @IsString()
  companyCode!: string;

  @Matches(CURRENCY_CODE_PATTERN)
  currency!: string;

  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lines!: [InvoiceLine, ...InvoiceLine[]];

  @IsOptional()
  @IsInt()
  @Min(0)
  @DiscountWithinComputedAmount()
  discount?: number;
}

export class InvoiceListRequestDto implements InvoiceListRequestPayload {
  @IsOptional()
  @IsIn(INVOICE_STATUSES)
  status?: InvoiceStatus;

  @IsOptional()
  @IsString()
  retailerCode?: string;

  @IsOptional()
  @IsString()
  companyCode?: string;

  @IsOptional()
  @Matches(ORDER_REFERENCE_PATTERN)
  orderReference?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  issuedBeforeMinutes?: number;

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
