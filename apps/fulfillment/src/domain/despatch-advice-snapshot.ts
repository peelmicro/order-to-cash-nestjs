// The plain snapshot shape a repository reconstitutes a read of `DespatchAdvice`
// from (fulfillment_despatch feature) — mirrors `stock-item-snapshot.ts`.
// `DespatchAdvice` is created once and never mutated again (no `release`,
// `consume` or similar verb applies to a despatch advice — domain-model.md
// §4.3 names no further transition), so unlike `StockItem` there is no
// `reconstitute` on the aggregate itself: the idempotent-repeat read path
// (F8) only ever needs this flat, non-reachable-for-mutation view, never a
// live aggregate instance.
import type { UniqueId } from '@otc/shared-kernel';

export interface DespatchLineSnapshot {
  readonly productCode: string;
  readonly units: number;
}

export interface DespatchAdviceSnapshot {
  readonly id: UniqueId;
  readonly despatchReference: string;
  readonly despatchDate: Date;
  readonly orderReference: string;
  readonly companyCode: string;
  readonly retailerCode: string;
  readonly lines: readonly DespatchLineSnapshot[];
}
