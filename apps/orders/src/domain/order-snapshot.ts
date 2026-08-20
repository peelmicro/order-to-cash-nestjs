// The reconstitution input type — design.md §4.2. A domain-shaped structure
// of value objects, not a Drizzle row: the repository adapter (feature 15)
// maps rows -> snapshot, resolving `company_id`/`retailer_id`/`currency_id`
// to codes/currency on its own side. The domain never sees a foreign key.
//
// Carries **no totals fields** (OA3): `Order.reconstitute` re-derives
// `initialAmount`/`initialDiscount`/`totalAmount` from `lines` rather than
// trust a stored value, so a stored/derived drift is unrepresentable rather
// than merely detected.
import type { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import type { CancellationReason } from './order-cancellation-reason.js';
import type { OrderStatus } from './order-status.js';

export interface OrderLineSnapshot {
  readonly id: UniqueId;
  readonly productCode: string;
  readonly description: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly lineDiscount: Money;
}

export interface OrderSnapshot {
  readonly id: UniqueId;
  readonly orderReference: OrderNumber;
  readonly orderDate: Date;
  readonly buyerGln: GLN;
  readonly retailerCode: string;
  readonly supplierGln: GLN;
  readonly companyCode: string;
  readonly currency: string;
  readonly lines: readonly OrderLineSnapshot[];
  readonly status: OrderStatus;
  readonly cancellationReason?: CancellationReason;
  readonly notes?: string;
}
