// Rows <-> `StockItem` aggregate (design.md §7, mirrors
// `apps/orders/.../order.mapper.ts`'s split). Adapter-internal: no query
// lives here, only shape translation. The domain never sees a `stock_id`
// foreign key — reservations carry their own business identifiers.
import { OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { StockItem } from '../../domain/stock-item.js';
import type { StockItemSnapshot } from '../../domain/stock-item-snapshot.js';
import type { ReservationSnapshot, ReservationStatus } from '../../domain/reservation.js';
import type { reservations, stock } from './schema';

export type StockRow = typeof stock.$inferSelect;
export type ReservationRow = typeof reservations.$inferSelect;

export function toStockItemSnapshot(row: StockRow, reservationRows: readonly ReservationRow[]): StockItemSnapshot {
  return {
    id: UniqueId.from(row.id),
    companyCode: row.companyCode,
    productCode: row.productCode,
    units: row.units,
    reservedUnits: row.reservedUnits,
    lowStockThreshold: row.lowStockThreshold,
    reservations: reservationRows.map(toReservationSnapshot),
  };
}

export function toReservationSnapshot(row: ReservationRow): ReservationSnapshot {
  return {
    id: UniqueId.from(row.id),
    orderReference: OrderNumber.of(row.orderReference),
    companyCode: row.companyCode,
    retailerCode: row.retailerCode,
    productCode: row.productCode,
    units: Quantity.of(row.units),
    status: row.status as ReservationStatus,
  };
}

export function reconstituteStockItem(row: StockRow, reservationRows: readonly ReservationRow[]): StockItem {
  return StockItem.reconstitute(toStockItemSnapshot(row, reservationRows));
}

/** One `stock` table row for one `saveAll()` — insert/update values, in either direction of `ON DUPLICATE KEY UPDATE`. */
export interface StockTableRow {
  id: string;
  companyCode: string;
  productCode: string;
  units: number;
  reservedUnits: number;
  lowStockThreshold: number;
  createdAt: Date;
  updatedAt: Date;
}

export function toStockTableRow(item: StockItem, timestamps: { readonly createdAt: Date; readonly updatedAt: Date }): StockTableRow {
  return {
    id: item.id.value,
    companyCode: item.companyCode,
    productCode: item.productCode,
    units: item.units,
    reservedUnits: item.reservedUnits,
    lowStockThreshold: item.lowStockThreshold,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  };
}

/** One `reservations` table row for one `saveAll()`. */
export interface ReservationTableRow {
  id: string;
  stockId: string;
  companyCode: string;
  retailerCode: string;
  productCode: string;
  orderReference: string;
  units: number;
  status: ReservationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export function toReservationTableRows(
  item: StockItem,
  timestamps: { readonly createdAt: Date; readonly updatedAt: Date },
): ReservationTableRow[] {
  return item.reservations.map((reservation) => ({
    id: reservation.id.value,
    stockId: item.id.value,
    companyCode: reservation.companyCode,
    retailerCode: reservation.retailerCode,
    productCode: reservation.productCode,
    orderReference: reservation.orderReference.value,
    units: reservation.units.value,
    status: reservation.status,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  }));
}
