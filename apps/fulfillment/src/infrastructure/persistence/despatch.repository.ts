// The Drizzle adapter for `DespatchRepository` (fulfillment_despatch
// feature). `findByOrderReference` is a plain, non-locking SELECT — F8's
// idempotent-repeat path relies on the `stock.reserve`/`.release` FOR UPDATE
// protocol (reused unchanged by `despatch.create`) to make the race
// structurally impossible, not on locking this table (`despatches.schema.ts`'s
// header explains why). `save` is a plain INSERT, never an upsert: a
// `DespatchAdvice` is created once and never updated again — the
// `uq_despatches_order_reference` constraint is the last-resort guard should
// that ever stop being true.
import { asc, eq } from 'drizzle-orm';
import { UniqueId, type OrderNumber } from '@otc/shared-kernel';
import type { Clock } from '../../application/ports/clock.port';
import type { DespatchRepository } from '../../application/ports/despatch-repository.port';
import type { TransactionContext } from '../../application/ports/unit-of-work.port';
import type { DespatchAdvice } from '../../domain/despatch-advice';
import type { DespatchAdviceSnapshot } from '../../domain/despatch-advice-snapshot';
import { OutboxRecorder } from '../outbox/outbox-recorder';
import { asDrizzleTx } from './drizzle-unit-of-work';
import type { FulfillmentDb } from './client';
import {
  toDespatchAdviceSnapshot,
  toDespatchItemTableRows,
  toDespatchTableRow,
} from './despatch.mapper';
import { despatchItems, despatches } from './schema';

export class DrizzleDespatchRepository implements DespatchRepository {
  constructor(
    private readonly db: FulfillmentDb,
    private readonly clock: Clock,
    private readonly outboxRecorder: OutboxRecorder = new OutboxRecorder(clock),
  ) {}

  async findByOrderReference(orderReference: OrderNumber): Promise<DespatchAdviceSnapshot | null> {
    const [despatchRow] = await this.db
      .select()
      .from(despatches)
      .where(eq(despatches.orderReference, orderReference.value));
    if (!despatchRow) {
      return null;
    }

    const itemRows = await this.db
      .select()
      .from(despatchItems)
      .where(eq(despatchItems.despatchId, despatchRow.id))
      .orderBy(asc(despatchItems.createdAt));

    return toDespatchAdviceSnapshot(despatchRow, itemRows);
  }

  /** Inserts the despatch row and its lines, then drains the aggregate's `pullDomainEvents()` (exactly one `order.despatched.v1`) into the outbox, all inside `tx` (R13). `tx` required — never opens its own. */
  async save(despatch: DespatchAdvice, tx: TransactionContext): Promise<void> {
    const db = asDrizzleTx(tx);
    const now = this.clock.now();

    await db
      .insert(despatches)
      .values(toDespatchTableRow(despatch, { createdAt: now, updatedAt: now }));

    const itemRows = toDespatchItemTableRows(
      despatch,
      { createdAt: now, updatedAt: now },
      () => UniqueId.generate().value,
    );
    if (itemRows.length > 0) {
      await db.insert(despatchItems).values(itemRows);
    }

    await this.outboxRecorder.record(tx, despatch.pullDomainEvents());
  }
}
