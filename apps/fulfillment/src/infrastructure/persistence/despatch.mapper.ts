// Rows <-> `DespatchAdvice` (fulfillment_despatch feature) — mirrors
// `stock-item.mapper.ts`'s split. Adapter-internal: no query lives here,
// only shape translation.
import { UniqueId } from '@otc/shared-kernel';
import type { DespatchAdvice } from '../../domain/despatch-advice.js';
import type { DespatchAdviceSnapshot } from '../../domain/despatch-advice-snapshot.js';
import type { despatchItems, despatches } from './schema';

export type DespatchRow = typeof despatches.$inferSelect;
export type DespatchItemRow = typeof despatchItems.$inferSelect;

export function toDespatchAdviceSnapshot(
  row: DespatchRow,
  itemRows: readonly DespatchItemRow[],
): DespatchAdviceSnapshot {
  return {
    id: UniqueId.from(row.id),
    despatchReference: row.despatchReference,
    despatchDate: row.despatchDate,
    orderReference: row.orderReference,
    companyCode: row.companyCode,
    retailerCode: row.retailerCode,
    lines: itemRows.map((item) => ({ productCode: item.productCode, units: item.units })),
  };
}

/** One `despatches` table row for one `save()`. */
export interface DespatchTableRow {
  id: string;
  despatchReference: string;
  despatchDate: Date;
  companyCode: string;
  retailerCode: string;
  orderReference: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toDespatchTableRow(
  despatch: DespatchAdvice,
  timestamps: { readonly createdAt: Date; readonly updatedAt: Date },
): DespatchTableRow {
  return {
    id: despatch.id.value,
    despatchReference: despatch.despatchReference.value,
    despatchDate: despatch.despatchDate,
    companyCode: despatch.companyCode,
    retailerCode: despatch.retailerCode,
    orderReference: despatch.orderReference.value,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  };
}

/** One `despatch_items` table row per line, for the same `save()`. */
export interface DespatchItemTableRow {
  id: string;
  despatchId: string;
  productCode: string;
  units: number;
  createdAt: Date;
  updatedAt: Date;
}

export function toDespatchItemTableRows(
  despatch: DespatchAdvice,
  timestamps: { readonly createdAt: Date; readonly updatedAt: Date },
  newId: () => string,
): DespatchItemTableRow[] {
  return despatch.lines.map((line) => ({
    id: newId(),
    despatchId: despatch.id.value,
    productCode: line.productCode,
    units: line.units.value,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  }));
}
