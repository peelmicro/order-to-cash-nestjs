// The write/read-model port for `despatch.create` (fulfillment_despatch
// feature) — the drain-on-save discipline `StockItemRepository`/
// `apps/orders/.../order-repository.port.ts` established.
import type { OrderNumber } from '@otc/shared-kernel';
import type { DespatchAdvice } from '../../domain/despatch-advice.js';
import type { DespatchAdviceSnapshot } from '../../domain/despatch-advice-snapshot.js';
import type { TransactionContext } from './unit-of-work.port.js';

export const DESPATCH_REPOSITORY = Symbol('DespatchRepository');

export interface DespatchRepository {
  /**
   * Non-locking read by `orderReference` (F8's idempotent-repeat path) —
   * `null` when no despatch exists yet for the order. Never opens or
   * requires a transaction: called both before the `stock.reserve`-style
   * lock is taken (the fast idempotent-repeat short-circuit) and, when
   * needed, from inside one, where it is safe because MySQL's `FOR UPDATE`
   * reads are current reads and a fresh, non-locking `SELECT` issued after
   * one in the SAME transaction sees the latest committed data (design.md
   * §4.3's reasoning, reused — see `despatch-creation.handler.ts`).
   */
  findByOrderReference(orderReference: OrderNumber): Promise<DespatchAdviceSnapshot | null>;

  /**
   * Inserts the despatch row and its lines, then drains the aggregate's
   * `pullDomainEvents()` (exactly one `order.despatched.v1`) into the
   * outbox, all inside `tx` (R13). `tx` required — never opens its own.
   */
  save(despatch: DespatchAdvice, tx: TransactionContext): Promise<void>;
}
