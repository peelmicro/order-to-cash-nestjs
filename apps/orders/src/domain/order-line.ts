// The `Order` aggregate's child entity — domain-model.md §3.1. Has identity
// within the aggregate and no life of its own (design.md §4.4): immutable
// fields, no setters. A "modification" produces a brand-new `OrderLine`
// with the same id (`withQuantity`); only `Order` ever puts it back into the
// collection. There is no reachable method on a line that mutates the
// aggregate — that is the mechanism, not a convention.
import { Entity, Money, Quantity, UniqueId } from '@otc/shared-kernel';

export interface OrderLineProps {
  readonly id: UniqueId;
  readonly productCode: string;
  readonly description: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly lineDiscount: Money;
}

export class OrderLine extends Entity<OrderLine> {
  private constructor(private readonly props: OrderLineProps) {
    super(props.id);
  }

  static create(props: OrderLineProps): OrderLine {
    return new OrderLine(props);
  }

  get productCode(): string {
    return this.props.productCode;
  }

  get description(): string {
    return this.props.description;
  }

  get quantity(): Quantity {
    return this.props.quantity;
  }

  get unitPrice(): Money {
    return this.props.unitPrice;
  }

  get lineDiscount(): Money {
    return this.props.lineDiscount;
  }

  /** Returns a new `OrderLine` with the same id and every other field unchanged except `quantity`. */
  withQuantity(quantity: Quantity): OrderLine {
    return new OrderLine({ ...this.props, quantity });
  }
}
