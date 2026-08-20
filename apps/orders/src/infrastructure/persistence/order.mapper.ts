// Rows <-> `Order` aggregate (`orders_aggregate` §9's mapping table).
// Adapter-internal: the domain never sees a reference-table id — every
// method here works with business codes/GLNs (what the aggregate knows)
// on one side and Drizzle row shapes (what MySQL knows) on the other. The
// repository resolves ids <-> codes against the reference tables and hands
// this module already-resolved values; no query lives here.
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { Order } from '../../domain/order';
import type { OrderLineSnapshot, OrderSnapshot } from '../../domain/order-snapshot';
import type { OrderStatusRow } from './schema/orders.schema';

/** An `orders` row already joined to its three reference tables — what `findById`/`findByReference`'s SELECT produces. */
export interface OrderRowWithCodes {
  readonly id: string;
  readonly orderReference: string;
  readonly orderDate: Date;
  readonly buyerGln: string;
  readonly retailerCode: string;
  readonly supplierGln: string;
  readonly companyCode: string;
  readonly currencyCode: string;
  readonly status: string;
  readonly cancellationReason: string | null;
  readonly notes: string | null;
}

/** An `order_items` row already joined to `products.code` — the wire/entity carries the code, never the row's own FK. */
export interface OrderItemRowWithCode {
  readonly id: string;
  readonly productCode: string;
  readonly description: string;
  readonly price: number;
  readonly quantity: number;
  readonly discount: number;
}

/** Reconstitutes the `Order` aggregate from its persisted rows (`order.mapper.ts` -> `Order.reconstitute`, `orders_aggregate` §4.2). */
export function toOrderSnapshot(
  row: OrderRowWithCodes,
  items: readonly OrderItemRowWithCode[],
): OrderSnapshot {
  const lines: OrderLineSnapshot[] = items.map((item) => ({
    id: UniqueId.from(item.id),
    productCode: item.productCode,
    description: item.description,
    quantity: Quantity.of(item.quantity),
    unitPrice: Money.of(item.price, row.currencyCode),
    lineDiscount: Money.of(item.discount, row.currencyCode),
  }));

  return {
    id: UniqueId.from(row.id),
    orderReference: OrderNumber.of(row.orderReference),
    orderDate: row.orderDate,
    buyerGln: GLN.of(row.buyerGln),
    retailerCode: row.retailerCode,
    supplierGln: GLN.of(row.supplierGln),
    companyCode: row.companyCode,
    currency: row.currencyCode,
    lines,
    status: row.status,
    cancellationReason: row.cancellationReason ?? undefined,
    notes: row.notes ?? undefined,
  } as OrderSnapshot;
}

export function reconstituteOrder(row: OrderRowWithCodes, items: readonly OrderItemRowWithCode[]): Order {
  return Order.reconstitute(toOrderSnapshot(row, items));
}

/** Ids the repository resolved from the aggregate's business codes before an upsert. */
export interface OrderRowIds {
  readonly companyId: string;
  readonly retailerId: string;
  readonly currencyId: string;
}

/** The `orders` table row for one `save()` — insert/update values, in either direction of `ON DUPLICATE KEY UPDATE` (design.md §4.3). */
export interface OrdersTableRow {
  id: string;
  orderReference: string;
  orderDate: Date;
  companyId: string;
  retailerId: string;
  currencyId: string;
  initialAmount: number;
  initialDiscount: number;
  totalAmount: number;
  status: OrderStatusRow;
  cancellationReason: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toOrdersTableRow(order: Order, ids: OrderRowIds, timestamps: { createdAt: Date; updatedAt: Date }): OrdersTableRow {
  return {
    id: order.id.value,
    orderReference: order.orderReference.value,
    orderDate: order.orderDate,
    companyId: ids.companyId,
    retailerId: ids.retailerId,
    currencyId: ids.currencyId,
    initialAmount: order.initialAmount.amount,
    initialDiscount: order.initialDiscount.amount,
    totalAmount: order.totalAmount.amount,
    status: order.status as OrderStatusRow,
    cancellationReason: order.cancellationReason ?? null,
    notes: order.notes ?? null,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  };
}

/** One `order_items` row for one `save()`. */
export interface OrderItemsTableRow {
  id: string;
  orderId: string;
  productId: string;
  description: string;
  price: number;
  quantity: number;
  discount: number;
  createdAt: Date;
  updatedAt: Date;
}

export function toOrderItemsTableRows(
  order: Order,
  productIdByCode: ReadonlyMap<string, string>,
  timestamps: { createdAt: Date; updatedAt: Date },
): OrderItemsTableRow[] {
  return order.lines.map((line) => {
    const productId = productIdByCode.get(line.productCode);
    if (!productId) {
      throw new Error(`order.mapper: unknown product code "${line.productCode}" — no products row resolves it`);
    }
    return {
      id: line.id.value,
      orderId: order.id.value,
      productId,
      description: line.description,
      price: line.unitPrice.amount,
      quantity: line.quantity.value,
      discount: line.lineDiscount.amount,
      createdAt: timestamps.createdAt,
      updatedAt: timestamps.updatedAt,
    };
  });
}
