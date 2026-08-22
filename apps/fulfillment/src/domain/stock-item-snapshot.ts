// The reconstitution input type — design.md §3.1, mirrors
// `apps/orders/src/domain/order-snapshot.ts`. A domain-shaped structure of
// value objects, not a Drizzle row: the repository adapter maps rows ->
// snapshot. `reservations` carries only the reservations LOADED with this
// item — scoped to the order being handled (design.md §3.1, §7).
import type { UniqueId } from '@otc/shared-kernel';
import type { ReservationSnapshot } from './reservation.js';

export interface StockItemSnapshot {
  readonly id: UniqueId;
  readonly companyCode: string;
  readonly productCode: string;
  readonly units: number;
  readonly reservedUnits: number;
  readonly lowStockThreshold: number;
  readonly reservations: readonly ReservationSnapshot[];
}
