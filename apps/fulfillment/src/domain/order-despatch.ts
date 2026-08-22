// The order-scoped despatch operation — a PURE domain service, the same
// shape `order-stock-reservation.ts` established (fulfillment_despatch
// feature, mirrors design.md §3.3's pattern for the sibling feature 17
// left unbuilt). `StockItem.consume` already exists (feature 17) and does
// the per-item work (F1/F2, domain-model.md §4.2 row 4); this function is
// what makes despatch ALL-OR-NOTHING-OBSERVED across the order's items and
// builds the single `order.despatched.v1` fact (R36) by creating the new
// `DespatchAdvice` aggregate. Unlike `reserveOrderStock`, there is no
// partial-failure branch to reject: R36's precondition ("the order holds no
// reservation in status reserved") is decided by the CALLER before this
// function runs (`despatch-creation.handler.ts` — it must first tell a
// genuine "nothing to despatch" refusal apart from an idempotent repeat,
// which needs the `despatches` table, not just the loaded `StockItem`s) —
// this function only ever sees items known to hold at least one `reserved`
// reservation of the order, so `no_reservations` here is a defensive,
// expected-unreachable branch, not the R36 refusal path itself.
import type { OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { DespatchReference } from '@otc/shared-kernel';
import { DespatchAdvice, type DespatchLineEntry } from './despatch-advice.js';
import type { StockContext, StockItem } from './stock-item.js';

export interface CreateDespatchInput {
  readonly orderReference: OrderNumber;
  readonly companyCode: string;
  readonly retailerCode: string;
  /** The order id — becomes the fact's `correlationId` (saga.md §1). */
  readonly correlationId: UniqueId;
}

export type CreateDespatchOutcome =
  | { readonly kind: 'created'; readonly despatch: DespatchAdvice }
  // Defensive — see the file header. No line of any item was `reserved` for
  // this order, so there is nothing to despatch and no fact is built.
  | { readonly kind: 'no_reservations' };

/**
 * Consumes every item's `reserved` reservations of `orderReference` (F1/F2,
 * `StockItem.consume`), collects one `DespatchLineEntry` per consumed
 * reservation (F7 — despatched units equal reserved units, 1:1 with the
 * reservation it traces to, mirroring `stockReservedEvent`'s
 * `reservations[]`), and — if anything was consumed — creates exactly one
 * `DespatchAdvice` (F6, F8) via `DespatchAdvice.create`, which itself
 * appends the `order.despatched.v1` fact. Pure: no I/O, no clock beyond
 * `ctx`, no id generation except through `newId`.
 */
export function createDespatchForOrder(
  items: readonly StockItem[],
  input: CreateDespatchInput,
  despatchReference: DespatchReference,
  ctx: StockContext,
  newId: () => UniqueId,
): CreateDespatchOutcome {
  const lines: DespatchLineEntry[] = [];

  for (const item of items) {
    const consumed = item.consume(input.orderReference);
    for (const reservation of consumed) {
      lines.push({ productCode: reservation.productCode, units: reservation.units });
    }
  }

  if (lines.length === 0) {
    return { kind: 'no_reservations' };
  }

  const despatch = DespatchAdvice.create(
    {
      id: newId(),
      despatchReference,
      despatchDate: ctx.occurredAt,
      orderReference: input.orderReference,
      companyCode: input.companyCode,
      retailerCode: input.retailerCode,
      lines,
    },
    input.correlationId,
    ctx,
  );

  return { kind: 'created', despatch };
}
