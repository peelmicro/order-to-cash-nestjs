// The durable pending/parked command mechanism as a port (design.md §6.3) —
// SO3's crash-window guarantee and SO5's observable parking. `enqueue` runs
// in the caller's transaction (the fact's own, SO3); `claimDue` opens and
// commits its OWN short transaction for the sweeper's claim step
// (design.md §6.4: "in one short transaction: claim... then, outside the
// transaction, dispatch"); `markSent`/`park` run outside any transaction,
// after a dispatch attempt has settled.
import type { OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { TransactionContext } from './unit-of-work.port.js';
import type { SagaCommandPayload } from '../saga-command-payloads.js';
import type { SagaCommandKind } from '../saga-steps.js';

export const SAGA_COMMAND_STORE = Symbol('SagaCommandStore');

export type SagaCommandStatus = 'pending' | 'sent' | 'parked';

export interface EnqueueSagaCommandInput {
  readonly id: UniqueId;
  readonly orderId: UniqueId;
  readonly orderReference: OrderNumber;
  readonly command: SagaCommandKind;
  readonly payload: SagaCommandPayload;
  readonly triggeringEventId: UniqueId;
}

export interface SagaCommandRecord {
  readonly id: UniqueId;
  readonly orderId: UniqueId;
  readonly orderReference: OrderNumber;
  readonly command: SagaCommandKind;
  readonly payload: SagaCommandPayload;
  readonly triggeringEventId: UniqueId;
  readonly status: SagaCommandStatus;
  readonly attempts: number;
}

/** `enqueued` — a new row was inserted; `already_owed` — a row for `(order_id, command)` already existed and was left untouched (D1: a distinct-eventId duplicate of a fact whose precondition still holds must not crash the consumer). Either outcome means the same thing to the caller: the command is owed and the existing row is the one to (re-)dispatch. */
export type EnqueueOutcome = 'enqueued' | 'already_owed';

export interface SagaCommandStore {
  /** Inserts the pending-command row inside `tx` — same transaction as the status change that owes it (SO3). Idempotent on `(order_id, command)`: a step can never owe the same command twice, and re-enqueuing an existing row is never a reset — its `id`, `status`, `attempts` and `payload` are left exactly as they were (D1). */
  enqueue(tx: TransactionContext, input: EnqueueSagaCommandInput): Promise<EnqueueOutcome>;

  /** The `(order_id, command)` lookup the fast-path `Issue…Command` handlers claim by (design.md §5.5) — `null` when the row is absent or no longer `pending` (a stale hop; the caller treats this as a silent no-op). */
  findByOrderAndCommand(orderId: UniqueId, command: SagaCommandKind): Promise<SagaCommandRecord | null>;

  /** The sweeper's batch claim (design.md §6.4): every `pending` row older than the crash-window grace period, or `parked` row whose capped-backoff `next_attempt_at` has arrived — `FOR UPDATE SKIP LOCKED`, inside `tx`. */
  claimDue(
    tx: TransactionContext,
    now: Date,
    limit: number,
    options: { readonly pendingGraceMs: number },
  ): Promise<readonly SagaCommandRecord[]>;

  /** `pending -> sent` on any resolved reply (business rejections included, SO6) — a conditional update (`WHERE status = 'pending'`), so a race against a second dispatcher is a harmless no-op. Returns whether THIS call performed the transition. */
  markSent(id: UniqueId): Promise<boolean>;

  /** `pending -> parked` on exhausted in-line attempts (SO5) — same conditional-update safety as `markSent`. */
  park(id: UniqueId, attempts: number, lastError: string, nextAttemptAt: Date): Promise<boolean>;
}
