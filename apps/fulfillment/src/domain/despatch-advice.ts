// The `DespatchAdvice` aggregate root (DESADV, domain-model.md §4.3) —
// fulfillment_despatch feature. Created once, by `order-despatch.ts`'s pure
// `createDespatchForOrder`, from the reservations a `stock.reserve` already
// moved to `consumed`; never mutated again. Emits exactly one
// `order.despatched.v1` fact at creation (F6/F7/F8, R36) — the same
// "aggregate emits, infrastructure publishes" discipline `StockItem` follows
// (domain-model.md §8 rule 5), via `AggregateRoot.pullDomainEvents()`.
import {
  AggregateRoot,
  type DespatchReference,
  type OrderNumber,
  type Quantity,
  type UniqueId,
} from '@otc/shared-kernel';
import { EmptyDespatchLinesError } from './despatch-errors.js';
import { orderDespatchedEvent } from './despatch-events.js';
import type { StockContext } from './stock-item.js';

export interface DespatchLineEntry {
  readonly productCode: string;
  readonly units: Quantity;
}

interface DespatchAdviceProps {
  readonly despatchReference: DespatchReference;
  readonly despatchDate: Date;
  readonly orderReference: OrderNumber;
  readonly companyCode: string;
  readonly retailerCode: string;
  readonly lines: readonly DespatchLineEntry[];
}

export class DespatchAdvice extends AggregateRoot<DespatchAdvice> {
  private constructor(
    id: UniqueId,
    private readonly props: DespatchAdviceProps,
  ) {
    super(id);
  }

  /**
   * The only way a `DespatchAdvice` comes into being. Refuses
   * (`EmptyDespatchLinesError`) an empty `lines` list — F6 — and appends the
   * `order.despatched.v1` fact to its own uncommitted event collection
   * before returning, so a caller can never observe a `DespatchAdvice` whose
   * fact was not recorded.
   */
  static create(
    input: {
      readonly id: UniqueId;
      readonly despatchReference: DespatchReference;
      readonly despatchDate: Date;
      readonly orderReference: OrderNumber;
      readonly companyCode: string;
      readonly retailerCode: string;
      readonly lines: readonly DespatchLineEntry[];
    },
    correlationId: UniqueId,
    ctx: StockContext,
  ): DespatchAdvice {
    if (input.lines.length === 0) {
      throw new EmptyDespatchLinesError(input.orderReference.value);
    }

    const despatch = new DespatchAdvice(input.id, {
      despatchReference: input.despatchReference,
      despatchDate: input.despatchDate,
      orderReference: input.orderReference,
      companyCode: input.companyCode,
      retailerCode: input.retailerCode,
      lines: input.lines,
    });

    despatch.addDomainEvent(orderDespatchedEvent(despatch, correlationId, ctx));

    return despatch;
  }

  get despatchReference(): DespatchReference {
    return this.props.despatchReference;
  }

  get despatchDate(): Date {
    return this.props.despatchDate;
  }

  get orderReference(): OrderNumber {
    return this.props.orderReference;
  }

  get companyCode(): string {
    return this.props.companyCode;
  }

  get retailerCode(): string {
    return this.props.retailerCode;
  }

  get lines(): readonly DespatchLineEntry[] {
    return this.props.lines;
  }
}
