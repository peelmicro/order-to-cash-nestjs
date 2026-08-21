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

export interface SagaCommandStore {
  /** Inserts the pending-command row inside `tx` — same transaction as the status change that owes it (SO3). Unique on `(order_id, command)`: a step can never owe the same command twice. */
  enqueue(tx: TransactionContext, input: EnqueueSagaCommandInput): Promise<void>;

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
