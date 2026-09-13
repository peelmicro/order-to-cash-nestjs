// The durable pending/parked command mechanism as a port (design.md §6.3) —
// SO3's crash-window guarantee and SO5's observable parking. `enqueue` runs
// in the caller's transaction (the fact's own, SO3); `claimDue` opens and
// commits its OWN short transaction for the sweeper's claim step
// (design.md §6.4: "in one short transaction: claim... then, outside the
// transaction, dispatch"); `markSent`/`park` run outside any transaction,
// after a dispatch attempt has settled.
import type { OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import type { TransactionContext } from './unit-of-work.port.js';
import type { SagaCommandPayload } from '../saga-command-payloads.js';
import type { SagaCommandKind } from '../saga-steps.js';

export const SAGA_COMMAND_STORE = Symbol('SagaCommandStore');

/**
 * `rejected` (feature 42) is the terminal end state for a command whose
 * responder replied with a terminal-business `RpcError` (e.g.
 * `PRECONDITION_FAILED`) — retrying it can never succeed, so it is a
 * dead end distinct from `parked` (which IS retry-eligible on a capped
 * backoff schedule). `claimDue`'s predicate matches only `pending` and
 * `parked`, so a `rejected` row is never re-claimed.
 */
export type SagaCommandStatus = 'pending' | 'sent' | 'parked' | 'rejected';

export interface EnqueueSagaCommandInput {
  readonly id: UniqueId;
  readonly orderId: UniqueId;
  readonly orderReference: OrderNumber;
  readonly command: SagaCommandKind;
  readonly payload: SagaCommandPayload;
  readonly triggeringEventId: UniqueId;
  /**
   * The full, unmodified `Envelope` `SagaFactHandler.handle` already holds
   * at `enqueue` time, and the Kafka topic it arrived on — captured
   * verbatim so `SagaCommandDispatcher.park(...)` can dead-letter the
   * triggering fact without a cross-service read (R29's dead-letter
   * clause / OR3, `observability_reliability` design.md §4.2).
   */
  readonly triggeringEventEnvelope: Envelope;
  readonly triggeringEventTopic: string;
}

export interface SagaCommandRecord {
  readonly id: UniqueId;
  readonly orderId: UniqueId;
  readonly orderReference: OrderNumber;
  readonly command: SagaCommandKind;
  readonly payload: SagaCommandPayload;
  readonly triggeringEventId: UniqueId;
  readonly triggeringEventEnvelope: Envelope;
  readonly triggeringEventTopic: string;
  readonly status: SagaCommandStatus;
  readonly attempts: number;
  /** OR3's "at most once per row" marker — `null` until the row's first park. */
  readonly deadLetteredAt: Date | null;
}

/** `enqueued` — a new row was inserted; `already_owed` — a row for `(order_id, command)` already existed and was left untouched (D1: a distinct-eventId duplicate of a fact whose precondition still holds must not crash the consumer). Either outcome means the same thing to the caller: the command is owed and the existing row is the one to (re-)dispatch. */
export type EnqueueOutcome = 'enqueued' | 'already_owed';

export interface SagaCommandStore {
  /** Inserts the pending-command row inside `tx` — same transaction as the status change that owes it (SO3). Idempotent on `(order_id, command)`: a step can never owe the same command twice, and re-enqueuing an existing row is never a reset — its `id`, `status`, `attempts` and `payload` are left exactly as they were (D1). */
  enqueue(tx: TransactionContext, input: EnqueueSagaCommandInput): Promise<EnqueueOutcome>;

  /** The `(order_id, command)` lookup the fast-path `Issue…Command` handlers claim by (design.md §5.5) — `null` when the row is absent or no longer `pending` (a stale hop; the caller treats this as a silent no-op). */
  findByOrderAndCommand(orderId: UniqueId, command: SagaCommandKind): Promise<SagaCommandRecord | null>;

  /**
   * SA-4 (saga.md §4.3, "A credit approval that arrives after the
   * cancellation") — "has an operator cancellation already been accepted
   * for this order?", read inside the caller's transaction (`tx`) so the
   * answer is consistent with the order row it was asked about.
   *
   * An `EXISTS`-shaped check over the order's `credit.release` and
   * `stock.release` rows, narrowed by envelope CONTENT
   * (`isOperatorCancelEnvelope`, `application/operator-cancel-envelope.ts`)
   * rather than by the command name: rows for BOTH commands are also
   * written by the fact-driven flow — R27's automatic `credit_rejected`
   * compensation enqueues `stock.release`, and `stock.released.v1`'s own
   * `credit_approved`/`confirmed` variant enqueues `credit.release` — and
   * those carry a REAL fact's envelope, which must NOT count as an operator
   * cancellation. There is no marker for this on the `Order` aggregate (the
   * `stock_reserved` branch of `CancelOrderHandler` deliberately leaves the
   * order untouched), so the enqueued row is the only durable evidence that
   * the cancellation was accepted.
   *
   * No status filter: a `sent`, `parked` or even `rejected` row still means
   * "an operator cancellation was requested for this order".
   */
  hasAcceptedOperatorCancel(tx: TransactionContext, orderId: UniqueId): Promise<boolean>;

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

  /**
   * `pending -> rejected` (or `parked -> rejected`) on a TERMINAL
   * business-rejection `RpcError` reply (feature 42) — the row will
   * never be retried again, so there is no `nextAttemptAt` to set.
   * Same conditional-update safety as `markSent`/`park`
   * (`WHERE status <> 'sent'`). `claimDue`'s predicate matches only
   * `pending`/`parked`, so a `rejected` row is structurally excluded
   * from every future sweep claim without any extra guard there.
   */
  markRejected(id: UniqueId, attempts: number, lastError: string): Promise<boolean>;

  /**
   * OR3's "at most once" claim — `UPDATE ... SET dead_lettered_at = NOW()
   * WHERE id = ? AND dead_lettered_at IS NULL`, a conditional update with
   * the same race-safety shape as `markSent`/`park`. Returns `true` only
   * for the ONE caller whose call actually set the column (this row's
   * first park); every later re-park of the same row — another exhausted
   * sweep cycle — returns `false`, so the caller knows not to repeat the
   * DLQ publish or the `order.saga_failed.v1` emission.
   */
  claimDeadLetter(id: UniqueId): Promise<boolean>;
}
