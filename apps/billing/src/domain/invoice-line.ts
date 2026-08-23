// `InvoiceLine` — the child entity of `Invoice` (domain-model.md §5.2,
// design.md §3.2) — maps to the `invoice_items` table (§3.6). Mirrors
// `apps/orders/src/domain/order-line.ts`'s shape: lines are snapshotted at
// issue and never change (the OrderLine precedent) — no mutator anywhere on
// this class.
import { Entity, type Money, type Quantity, type UniqueId } from '@otc/shared-kernel';

export interface InvoiceLineSnapshot {
  readonly id: UniqueId;
  readonly productCode: string;
  readonly units: Quantity;
  readonly unitPrice: Money;
}

interface InvoiceLineProps {
  readonly productCode: string;
  readonly units: Quantity;
  readonly unitPrice: Money;
}

export class InvoiceLine extends Entity<InvoiceLine> {
  private constructor(
    id: UniqueId,
    private readonly props: InvoiceLineProps,
  ) {
    super(id);
  }

  /** The only construction site for a NEW line — always through `Invoice.issue`, never directly by infrastructure. */
  static create(input: { readonly id: UniqueId; readonly productCode: string; readonly units: Quantity; readonly unitPrice: Money }): InvoiceLine {
    return new InvoiceLine(input.id, { productCode: input.productCode, units: input.units, unitPrice: input.unitPrice });
  }

  static reconstitute(snapshot: InvoiceLineSnapshot): InvoiceLine {
    return new InvoiceLine(snapshot.id, { productCode: snapshot.productCode, units: snapshot.units, unitPrice: snapshot.unitPrice });
  }

  get productCode(): string {
    return this.props.productCode;
  }

  get units(): Quantity {
    return this.props.units;
  }

  get unitPrice(): Money {
    return this.props.unitPrice;
  }

  /** `unitPrice × units` — the only arithmetic on a line, and the only input to B6. */
  get lineTotal(): Money {
    return this.props.unitPrice.multiply(this.props.units);
  }

  toSnapshot(): InvoiceLineSnapshot {
    return { id: this.id, productCode: this.props.productCode, units: this.props.units, unitPrice: this.props.unitPrice };
  }
}
