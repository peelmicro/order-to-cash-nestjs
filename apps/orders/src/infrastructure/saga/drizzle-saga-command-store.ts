// The Drizzle adapter for `SagaCommandStore` (design.md §6.3, §6.4).
// `enqueue` writes inside the caller's (the fact's) transaction; `claimDue`
// opens and commits its own short transaction, `FOR UPDATE SKIP LOCKED`,
// for the sweeper's claim step; `markSent`/`park` are conditional updates
// (`WHERE status = 'pending'`) so a race between the fast path and the
// sweeper — or between two scaled-out sweeper instances — resolves
// harmlessly (design.md §5.5, §6.4).
import { and, eq, lt, lte, or, sql } from 'drizzle-orm';
import { OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import type { Clock } from '../../application/ports/clock.port.js';
import type {
  EnqueueOutcome,
  EnqueueSagaCommandInput,
  SagaCommandRecord,
  SagaCommandStore,
} from '../../application/ports/saga-command-store.port.js';
import { isOperatorCancelEnvelope } from '../../application/operator-cancel-envelope.js';
import type { SagaCommandPayload } from '../../application/saga-command-payloads.js';
import type { SagaCommandKind } from '../../application/saga-steps.js';
import type { TransactionContext } from '../../application/ports/unit-of-work.port.js';
import type { OrdersDb } from '../persistence/client.js';
import { asDrizzleTx, type OrdersTx } from '../persistence/drizzle-unit-of-work.js';
import { sagaCommands } from '../persistence/schema/index.js';

type Queryable = OrdersDb | OrdersTx;

function toRecord(row: typeof sagaCommands.$inferSelect): SagaCommandRecord {
  return {
    id: UniqueId.from(row.id),
    orderId: UniqueId.from(row.orderId),
    orderReference: OrderNumber.of(row.orderReference),
    command: row.command as SagaCommandKind,
    payload: row.payload as SagaCommandPayload,
    triggeringEventId: UniqueId.from(row.triggeringEventId),
    triggeringEventEnvelope: row.triggeringEventEnvelope as Envelope,
    triggeringEventTopic: row.triggeringEventTopic ?? '',
    status: row.status,
    attempts: row.attempts,
    deadLetteredAt: row.deadLetteredAt ?? null,
  };
}

export class DrizzleSagaCommandStore implements SagaCommandStore {
  constructor(
    private readonly db: OrdersDb,
    private readonly clock: Clock,
  ) {}

  /** `INSERT ... ON DUPLICATE KEY UPDATE id = id` — MySQL's idiom for "insert or leave untouched" on `uq_saga_commands_order_command` (D1). `affectedRows` is 1 for a fresh insert, 0 when the duplicate-key branch fired and changed nothing (setting `id` to its own value never counts as a row update). */
  async enqueue(tx: TransactionContext, input: EnqueueSagaCommandInput): Promise<EnqueueOutcome> {
    const db = asDrizzleTx(tx);
    const now = this.clock.now();
    const result = await db
      .insert(sagaCommands)
      .values({
        id: input.id.value,
        orderId: input.orderId.value,
        orderReference: input.orderReference.value,
        command: input.command,
        payload: input.payload,
        triggeringEventId: input.triggeringEventId.value,
        triggeringEventEnvelope: input.triggeringEventEnvelope,
        triggeringEventTopic: input.triggeringEventTopic,
        status: 'pending',
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
        deadLetteredAt: null,
        createdAt: now,
        updatedAt: now,
        sentAt: null,
      })
      .onDuplicateKeyUpdate({ set: { id: sql`id` } });
    return affectedRows(result) === 1 ? 'enqueued' : 'already_owed';
  }

  async findByOrderAndCommand(orderId: UniqueId, command: SagaCommandKind): Promise<SagaCommandRecord | null> {
    return this.findOne(this.db, and(eq(sagaCommands.orderId, orderId.value), eq(sagaCommands.command, command))!);
  }

  /**
   * SA-4 — see the port's own doc-comment for WHY this tests envelope
   * content rather than the command name. Read through `tx`, the caller's
   * own transaction: `SagaFactHandler` asks this immediately after loading
   * the order inside the same transactional unit, so both reads see one
   * consistent snapshot.
   *
   * `isOperatorCancelEnvelope` is applied in TypeScript rather than as a
   * SQL `->>'$.eventType'` predicate on purpose: the two rows this scans
   * are bounded (the unique key is `(order_id, command)`, so at most one
   * `credit.release` and one `stock.release` row can ever exist per order),
   * and the SAME predicate the writer uses then decides both sides.
   */
  async hasAcceptedOperatorCancel(tx: TransactionContext, orderId: UniqueId): Promise<boolean> {
    const db = asDrizzleTx(tx);
    const rows = await db
      .select({ triggeringEventEnvelope: sagaCommands.triggeringEventEnvelope })
      .from(sagaCommands)
      .where(
        and(
          eq(sagaCommands.orderId, orderId.value),
          or(eq(sagaCommands.command, 'credit.release'), eq(sagaCommands.command, 'stock.release')),
        ),
      );

    return rows.some((row) => isOperatorCancelEnvelope(row.triggeringEventEnvelope as Envelope | null));
  }

  async claimDue(
    tx: TransactionContext,
    now: Date,
    limit: number,
    options: { readonly pendingGraceMs: number },
  ): Promise<readonly SagaCommandRecord[]> {
    const db = asDrizzleTx(tx);
    const graceCutoff = new Date(now.getTime() - options.pendingGraceMs);

    const rows = await db
      .select()
      .from(sagaCommands)
      .where(
        or(
          and(eq(sagaCommands.status, 'pending'), lt(sagaCommands.createdAt, graceCutoff)),
          and(eq(sagaCommands.status, 'parked'), lte(sagaCommands.nextAttemptAt, now)),
        ),
      )
      .limit(limit)
      .for('update', { skipLocked: true });

    return rows.map(toRecord);
  }

  /** `pending -> sent` (fast path) or `parked -> sent` (a sweep resuming a previously-parked row) — never `sent -> sent` (a stale hop is a no-op, design.md §5.5). */
  async markSent(id: UniqueId): Promise<boolean> {
    const now = this.clock.now();
    const result = await this.db
      .update(sagaCommands)
      .set({ status: 'sent', updatedAt: now, sentAt: now })
      .where(and(eq(sagaCommands.id, id.value), notAlreadySent()));
    return affectedRows(result) > 0;
  }

  /** `pending -> parked` (exhausted in-line attempts) or `parked -> parked` (a sweep cycle that exhausts again, bumping attempts/error/next-attempt) — never once the row is `sent`. */
  async park(id: UniqueId, attempts: number, lastError: string, nextAttemptAt: Date): Promise<boolean> {
    const result = await this.db
      .update(sagaCommands)
      .set({
        status: 'parked',
        attempts,
        lastError,
        nextAttemptAt,
        updatedAt: this.clock.now(),
      })
      .where(and(eq(sagaCommands.id, id.value), notAlreadySent()));
    return affectedRows(result) > 0;
  }

  /** `pending -> rejected` (or `parked -> rejected`) on a terminal business-rejection `RpcError` reply (feature 42) — no `next_attempt_at` to set, this row is never retried again. Same conditional-update safety as `markSent`/`park`. */
  async markRejected(id: UniqueId, attempts: number, lastError: string): Promise<boolean> {
    const result = await this.db
      .update(sagaCommands)
      .set({
        status: 'rejected',
        attempts,
        lastError,
        nextAttemptAt: null,
        updatedAt: this.clock.now(),
      })
      .where(and(eq(sagaCommands.id, id.value), notAlreadySent()));
    return affectedRows(result) > 0;
  }

  /** OR3's "at most once" claim (design.md §4.2 point 1) — a conditional update, same race-safety shape as `markSent`/`park`. */
  async claimDeadLetter(id: UniqueId): Promise<boolean> {
    const result = await this.db
      .update(sagaCommands)
      .set({ deadLetteredAt: this.clock.now() })
      .where(and(eq(sagaCommands.id, id.value), sql`${sagaCommands.deadLetteredAt} IS NULL`));
    return affectedRows(result) > 0;
  }

  private async findOne(db: Queryable, condition: NonNullable<ReturnType<typeof and>>): Promise<SagaCommandRecord | null> {
    const [row] = await db.select().from(sagaCommands).where(condition).limit(1);
    return row ? toRecord(row) : null;
  }
}

/** Guards `markSent`/`park` against overwriting a row that has already been reported `sent` by a concurrent dispatcher — the only status this store never lets a conditional update leave. */
function notAlreadySent() {
  return sql`${sagaCommands.status} <> 'sent'`;
}

/** mysql2's `insert`/`update` result shape carries `affectedRows` at index 0 of the returned tuple-like `ResultSetHeader`; Drizzle's mysql2 driver returns it as `[ResultSetHeader, FieldPacket[]]`. */
function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  const value = (header as { affectedRows?: number } | undefined)?.affectedRows;
  return typeof value === 'number' ? value : 0;
}
