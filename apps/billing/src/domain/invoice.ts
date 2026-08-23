// The `Invoice` aggregate root — domain-model.md §5.2, design.md §3.1.
// Mirrors `buyer-credit.ts`'s shape: a pure function of its inputs (no
// clock, no port — everything comes in through `InvoiceContext` or method
// arguments).
import { AggregateRoot, Money, UniqueId, type DomainEventEnvelope, type InvoiceReference, type OrderNumber, type Quantity } from '@otc/shared-kernel';
import type { InvoiceLine as InvoiceLinePayload, PaymentReceivedPayload } from '@otc/contracts';
import { InvoiceLine, type InvoiceLineSnapshot } from './invoice-line.js';
import type { InvoiceSnapshot } from './invoice-snapshot.js';
import { invoiceIssuedEvent, paymentReceivedEvent } from './invoice-events.js';
import {
  EmptyInvoiceLinesError,
  InvalidInvoiceSnapshotError,
  InvoiceAlreadyPaidError,
  InvoiceLineCurrencyMismatchError,
  InvoicePaymentAmountMismatchError,
  InvoicePaymentCurrencyMismatchError,
  NegativeInvoiceTotalError,
} from './invoice-errors.js';

/** Time and causation in, nothing pulled — mirrors `buyer-credit.ts`'s `CreditContext`. */
export interface InvoiceContext {
  readonly occurredAt: Date;
  readonly causationId: UniqueId;
}

export interface InvoiceLineInput {
  readonly productCode: string;
  readonly units: Quantity;
  readonly unitPrice: Money;
}

export interface IssueInvoiceInput {
  readonly id: UniqueId;
  readonly invoiceReference: InvoiceReference;
  readonly invoiceDate: Date;
  readonly orderReference: OrderNumber;
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly currency: string;
  readonly lines: readonly InvoiceLineInput[];
  /** `Money.of(0, currency)` when the request omits it. */
  readonly discount: Money;
  /** The order id, from `x-correlation-id`. */
  readonly correlationId: UniqueId;
}

export interface MarkPaidInput {
  readonly paymentReference: string;
  /** Must equal `totalAmount` exactly — B10. */
  readonly amount: Money;
  readonly valueDate: Date;
  readonly source: PaymentReceivedPayload['source'];
  readonly correlationId: UniqueId;
}

/** B9 made unrepresentable: `status` and `paidAt` are ONE value, so neither can exist without the other. */
export type InvoiceState = { readonly status: 'issued' } | { readonly status: 'paid'; readonly paidAt: Date };

interface InvoiceProps {
  readonly invoiceReference: InvoiceReference;
  readonly invoiceDate: Date;
  readonly orderReference: OrderNumber;
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly currency: string;
  readonly lines: readonly InvoiceLine[];
  readonly amount: Money;
  readonly discount: Money;
  readonly totalAmount: Money;
  readonly state: InvoiceState;
}

function invoiceLinePayloadsOf(lines: readonly InvoiceLine[]): InvoiceLinePayload[] {
  return lines.map((line) => ({ productCode: line.productCode, units: line.units.value, unitPrice: line.unitPrice.amount }));
}

export class Invoice extends AggregateRoot<Invoice> {
  private constructor(
    id: UniqueId,
    private props: InvoiceProps,
  ) {
    super(id);
  }

  /**
   * The ONLY way an Invoice comes into being. Derives `amount`/`totalAmount`
   * from the lines, refuses B6 violations, and appends exactly one
   * `invoice.issued.v1` before returning — a caller can never observe an
   * Invoice whose fact was not recorded (the `DespatchAdvice.create`
   * precedent, design.md §3.1).
   */
  static issue(input: IssueInvoiceInput, ctx: InvoiceContext): Invoice {
    if (input.lines.length === 0) {
      throw new EmptyInvoiceLinesError(input.orderReference.value);
    }

    const lines = input.lines.map((line) => {
      if (line.unitPrice.currency !== input.currency) {
        throw new InvoiceLineCurrencyMismatchError(input.currency, line.unitPrice.currency);
      }
      return InvoiceLine.create({
        id: UniqueId.generate(),
        productCode: line.productCode,
        units: line.units,
        unitPrice: line.unitPrice,
      });
    });

    const amount = lines.reduce((sum, line) => sum.add(line.lineTotal), Money.zero(input.currency));
    // `Money.subtract` itself throws `CurrencyMismatchError` (a
    // `DomainError`, `@otc/shared-kernel`) if `input.discount` were ever a
    // foreign currency — no separate check needed here; the application
    // layer's handler always builds `discount` in the request's own
    // currency (`Money.of(0, currency)` when the request omits it, design
    // §3.1).
    const totalAmount = amount.subtract(input.discount);
    if (totalAmount.isNegative()) {
      throw new NegativeInvoiceTotalError(amount.amount, input.discount.amount);
    }

    const invoice = new Invoice(input.id, {
      invoiceReference: input.invoiceReference,
      invoiceDate: input.invoiceDate,
      orderReference: input.orderReference,
      retailerCode: input.retailerCode,
      companyCode: input.companyCode,
      currency: input.currency,
      lines,
      amount,
      discount: input.discount,
      totalAmount,
      state: { status: 'issued' },
    });

    const event = invoiceIssuedEvent(
      invoice,
      {
        orderReference: input.orderReference.value,
        retailerCode: input.retailerCode,
        companyCode: input.companyCode,
        currency: input.currency,
        lines: invoiceLinePayloadsOf(lines),
        amount: amount.amount,
        discount: input.discount.amount,
        totalAmount: totalAmount.amount,
      },
      input.correlationId,
      ctx,
    );
    invoice.appendFact(event);

    return invoice;
  }

  /**
   * Refuses (`InvalidInvoiceSnapshotError`) a row whose `status` and
   * `paidAt` disagree, whose totals do not reconcile with its lines, or
   * whose currency is not shared by every line (`BI10`, `BI11`, B6, B9).
   */
  static reconstitute(snapshot: InvoiceSnapshot): Invoice {
    if (snapshot.status === 'paid' && snapshot.paidAt === null) {
      throw new InvalidInvoiceSnapshotError(`status is "paid" but paidAt is null — violates B9`, snapshot.id);
    }
    if (snapshot.status === 'issued' && snapshot.paidAt !== null) {
      throw new InvalidInvoiceSnapshotError(`status is "issued" but paidAt is set (${snapshot.paidAt.toISOString()}) — violates B9`, snapshot.id);
    }

    for (const line of snapshot.lines) {
      if (line.unitPrice.currency !== snapshot.currency) {
        throw new InvalidInvoiceSnapshotError(
          `line ${line.id.value} currency (${line.unitPrice.currency}) does not match the invoice's currency (${snapshot.currency}) — violates B6`,
          snapshot.id,
        );
      }
    }

    const recomputedAmount = snapshot.lines.reduce(
      (sum, line) => sum.add(line.unitPrice.multiply(line.units)),
      Money.zero(snapshot.currency),
    );
    if (!recomputedAmount.equals(snapshot.amount)) {
      throw new InvalidInvoiceSnapshotError(
        `stored amount (${snapshot.amount.amount}) does not reconcile with the lines' total (${recomputedAmount.amount}) — violates B6`,
        snapshot.id,
      );
    }
    const recomputedTotal = recomputedAmount.subtract(snapshot.discount);
    if (!recomputedTotal.equals(snapshot.totalAmount)) {
      throw new InvalidInvoiceSnapshotError(
        `stored totalAmount (${snapshot.totalAmount.amount}) does not reconcile with amount − discount (${recomputedTotal.amount}) — violates B6`,
        snapshot.id,
      );
    }

    const state: InvoiceState = snapshot.status === 'paid' ? { status: 'paid', paidAt: snapshot.paidAt as Date } : { status: 'issued' };

    return new Invoice(snapshot.id, {
      invoiceReference: snapshot.invoiceReference,
      invoiceDate: snapshot.invoiceDate,
      orderReference: snapshot.orderReference,
      retailerCode: snapshot.retailerCode,
      companyCode: snapshot.companyCode,
      currency: snapshot.currency,
      lines: snapshot.lines.map((line) => InvoiceLine.reconstitute(line)),
      amount: snapshot.amount,
      discount: snapshot.discount,
      totalAmount: snapshot.totalAmount,
      state,
    });
  }

  get invoiceReference(): InvoiceReference {
    return this.props.invoiceReference;
  }

  get invoiceDate(): Date {
    return this.props.invoiceDate;
  }

  get orderReference(): OrderNumber {
    return this.props.orderReference;
  }

  get retailerCode(): string {
    return this.props.retailerCode;
  }

  get companyCode(): string {
    return this.props.companyCode;
  }

  get currency(): string {
    return this.props.currency;
  }

  get lines(): readonly InvoiceLine[] {
    return this.props.lines;
  }

  get amount(): Money {
    return this.props.amount;
  }

  get discount(): Money {
    return this.props.discount;
  }

  get totalAmount(): Money {
    return this.props.totalAmount;
  }

  /** Projection of `state` — never a settable field (B9). */
  get status(): 'issued' | 'paid' {
    return this.props.state.status;
  }

  /** Projection of `state` — null iff issued, by construction (B9). */
  get paidAt(): Date | null {
    return this.props.state.status === 'paid' ? this.props.state.paidAt : null;
  }

  /**
   * FEATURE 22's caller, delivered here. `issued -> paid` in one
   * indivisible step, appending exactly one `payment.received.v1`. Throws
   * `InvoiceAlreadyPaidError` (B8), `InvoicePaymentCurrencyMismatchError`
   * or `InvoicePaymentAmountMismatchError` (B10) — each of which changes
   * nothing and appends no event.
   */
  markPaid(input: MarkPaidInput, ctx: InvoiceContext): void {
    if (this.props.state.status === 'paid') {
      throw new InvoiceAlreadyPaidError(this.props.invoiceReference.value);
    }
    if (input.amount.currency !== this.props.currency) {
      throw new InvoicePaymentCurrencyMismatchError(this.props.currency, input.amount.currency);
    }
    if (!input.amount.equals(this.props.totalAmount)) {
      throw new InvoicePaymentAmountMismatchError(this.props.totalAmount.amount, input.amount.amount);
    }

    this.props = { ...this.props, state: { status: 'paid', paidAt: ctx.occurredAt } };

    const event = paymentReceivedEvent(
      this,
      {
        orderReference: this.props.orderReference.value,
        paymentReference: input.paymentReference,
        currency: this.props.currency,
        amount: input.amount.amount,
        valueDate: input.valueDate,
        source: input.source,
      },
      input.correlationId,
      ctx,
    );
    this.appendFact(event);
  }

  toSnapshot(): InvoiceSnapshot {
    return {
      id: this.id,
      invoiceReference: this.props.invoiceReference,
      invoiceDate: this.props.invoiceDate,
      orderReference: this.props.orderReference,
      retailerCode: this.props.retailerCode,
      companyCode: this.props.companyCode,
      currency: this.props.currency,
      lines: this.props.lines.map((line) => line.toSnapshot()) as readonly InvoiceLineSnapshot[],
      amount: this.props.amount,
      discount: this.props.discount,
      totalAmount: this.props.totalAmount,
      status: this.props.state.status,
      paidAt: this.paidAt,
    };
  }

  /** Mirrors `buyer-credit.ts`'s `appendFact` guard (domain-model.md §8 rule 5) — every fact this aggregate builds names itself as `aggregateId`, so a mismatch can never actually happen; kept for symmetry with the reference implementation. */
  private appendFact(event: DomainEventEnvelope): void {
    if (!event.aggregateId.equals(this.id)) {
      throw new InvalidInvoiceSnapshotError(`refuses to record a fact whose aggregateId (${event.aggregateId.value}) is not its own`, this.id);
    }
    this.addDomainEvent(event);
  }
}
