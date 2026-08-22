// The Drizzle adapter for `BuyerCreditRepository` (design.md §5.5, §7.1).
// `lockForOrder` is the ONLY place this service takes `FOR UPDATE` — three
// statements, in the fixed order §5.5 names, never `SKIP LOCKED` here: a
// contender must WAIT, not skip (BC9's single-row-lock protocol).
import { and, eq, sql } from 'drizzle-orm';
import type { OrderNumber } from '@otc/shared-kernel';
import type { Clock } from '../../application/ports/clock.port';
import type { BuyerCreditRepository } from '../../application/ports/buyer-credit-repository.port';
import type { TransactionContext } from '../../application/ports/unit-of-work.port';
import type { BuyerCredit } from '../../domain/buyer-credit';
import { OutboxRecorder } from '../outbox/outbox-recorder';
import { asDrizzleTx } from './drizzle-unit-of-work';
import type { BillingDb } from './client';
import { reconstituteBuyerCredit, toCreditItemTableRows } from './buyer-credit.mapper';
import { creditItems, credits } from './schema';

export class DrizzleBuyerCreditRepository implements BuyerCreditRepository {
  constructor(
    private readonly db: BillingDb,
    private readonly clock: Clock,
    private readonly outboxRecorder: OutboxRecorder = new OutboxRecorder(clock),
  ) {}

  /**
   * §5.5 steps 1-3, in this order and no other:
   *   1. the `credits` row of `(retailerCode, companyCode)`, `FOR UPDATE`
   *      (`uq_credits_retailer_company`) — `null` when absent (BC3).
   *   2. the whole line's `committedExposure` — ONE scalar, no `GROUP BY`
   *      (BC5), `FOR UPDATE`.
   *   3. the subject order's entries — index seek on
   *      `idx_credit_items_credit_order`, `FOR UPDATE`.
   */
  async lockForOrder(
    tx: TransactionContext,
    retailerCode: string,
    companyCode: string,
    orderReference: OrderNumber,
  ): Promise<BuyerCredit | null> {
    const db = asDrizzleTx(tx);

    const [creditRow] = await db
      .select()
      .from(credits)
      .where(and(eq(credits.retailerCode, retailerCode), eq(credits.companyCode, companyCode)))
      .for('update');

    if (!creditRow) {
      return null;
    }

    const [exposureRow] = await db
      .select({
        committedExposure: sql<number>`COALESCE(SUM(CASE ${creditItems.type} WHEN 'hold' THEN ${creditItems.amount} WHEN 'release' THEN -${creditItems.amount} ELSE 0 END), 0)`,
      })
      .from(creditItems)
      .where(eq(creditItems.creditId, creditRow.id))
      .for('update');

    const orderItemRows = await db
      .select()
      .from(creditItems)
      .where(and(eq(creditItems.creditId, creditRow.id), eq(creditItems.orderReference, orderReference.value)))
      .for('update');

    return reconstituteBuyerCredit(creditRow, Number(exposureRow?.committedExposure ?? 0), orderItemRows);
  }

  /** INSERTs `credit.appendedEntries` ONLY — no `UPDATE`, no `DELETE` anywhere in this file (B2, mechanical) — then drains the outbox. `tx` required — never opens its own. The `credits` row itself is NEVER written: nothing in this feature changes a credit limit. */
  async save(credit: BuyerCredit, tx: TransactionContext): Promise<void> {
    const db = asDrizzleTx(tx);
    const now = this.clock.now();

    const rows = toCreditItemTableRows(credit, { createdAt: now, updatedAt: now });
    if (rows.length > 0) {
      await db.insert(creditItems).values(rows);
    }

    const events = credit.pullDomainEvents();
    await this.outboxRecorder.record(tx, events);
  }
}
