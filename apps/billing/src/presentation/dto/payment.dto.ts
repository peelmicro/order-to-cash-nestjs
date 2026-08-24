// The `billing.payment.register` request DTO (feature 22) — `implements`
// its generated `@otc/contracts` request payload field-for-field, the
// `InvoiceIssueRequestDto` precedent. Validated manually inside
// `invoice.controller.ts` (not a global `ValidationPipe`) so a validation
// failure becomes an `RpcError`-shaped reply under this feature's own
// control.
import 'reflect-metadata';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  registerDecorator,
  ValidateNested,
  type ValidationArguments,
  type ValidationOptions,
  type ValidatorConstraintInterface,
  ValidatorConstraint,
} from 'class-validator';
import type { PaymentRegisterRequestPayload, PaymentSource } from '@otc/contracts';
import { MoneyDto } from './credit.dto';

const INVOICE_REFERENCE_PATTERN = /^INV-\d{6}$/;
const PAYMENT_SOURCES: readonly PaymentSource[] = ['operator', 'robot', 'test'];

/**
 * `PaymentRegisterRequestPayload` declares BOTH `invoiceId` and
 * `invoiceReference` optional (`asyncapi.yaml`) — a caller must name the
 * target invoice by ONE of the two. Neither present is a request the
 * handler cannot resolve at all; this constraint refuses it BEFORE any
 * transaction opens, the same `DiscountWithinComputedAmount` cross-field
 * precedent `invoice.dto.ts` established.
 */
@ValidatorConstraint({ name: 'atLeastOneInvoiceIdentifier', async: false })
class AtLeastOneInvoiceIdentifierConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as { invoiceId?: unknown; invoiceReference?: unknown };
    return dto.invoiceId !== undefined || dto.invoiceReference !== undefined;
  }

  defaultMessage(): string {
    return 'at least one of invoiceId or invoiceReference is required';
  }
}

function AtLeastOneInvoiceIdentifier(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: AtLeastOneInvoiceIdentifierConstraint,
    });
  };
}

export class PaymentRegisterRequestDto implements PaymentRegisterRequestPayload {
  @IsOptional()
  @IsUUID('4')
  invoiceId?: string;

  @IsOptional()
  @Matches(INVOICE_REFERENCE_PATTERN)
  invoiceReference?: string;

  // `AtLeastOneInvoiceIdentifier` lives here, NOT on `invoiceId` itself:
  // `@IsOptional()` skips EVERY validator on the property it decorates
  // when the value is absent, which would skip this cross-field check
  // exactly when it needs to run. `paymentReference` carries no
  // `@IsOptional()`, so this decorator is evaluated unconditionally.
  @MinLength(1)
  @MaxLength(30)
  @AtLeastOneInvoiceIdentifier()
  paymentReference!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  amount!: MoneyDto;

  @IsISO8601()
  valueDate!: string;

  @IsIn(PAYMENT_SOURCES)
  source!: PaymentSource;
}
