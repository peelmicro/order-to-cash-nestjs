// The in-line retry policy (SO4) + park transition (SO5) + business-vs-
// transport split (SO6) — design.md §6.2. Invoked from exactly two places
// (design.md §5.5): the `Issue…Command` handlers (the fast path, off the
// Kafka consumer's await chain — §3.2) and the sweeper (the guarantee,
// §6.4, called DIRECTLY, never via the `CommandBus`).
//
// BUDGET ARITHMETIC (design.md §3.2, §6.2) — read this before touching the
// defaults: 3 attempts × 5 000 ms timeout + (500 ms + 1 000 ms) backoff =
// 16 500 ms worst case per command. This runs off the Kafka consumer's
// await chain (the fact `@CommandHandler` only awaits the transactional
// unit, not this dispatch), so it does NOT compete with kafkajs's 30 s
// `sessionTimeout` — but it DOES bound how long one sweeper cycle's
// dispatch phase can take per claimed row (dispatches run sequentially,
// design.md §6.4), so raising these numbers lengthens the sweep cycle,
// not the partition.
import type { UniqueId } from '@otc/shared-kernel';
import { activeTraceId } from '../observability/trace-context.js';
import type { SagaCommandRecord, SagaCommandStore } from '../../application/ports/saga-command-store.port';
import {
  SagaCommandBusinessRejectionError,
  SagaCommandTimeoutError,
  SagaCommandTransportError,
  type SagaCommandMeta,
  type SagaCommandsPort,
} from '../../application/ports/saga-commands.port';
import type { SagaCommandPayload } from '../../application/saga-command-payloads';
import type { SagaCommandKind } from '../../application/saga-steps';

export interface SagaCommandDispatcherConfig {
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly parkRetryCapMs: number;
}

export const DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG: SagaCommandDispatcherConfig = {
  timeoutMs: 5000,
  maxAttempts: 3,
  backoffBaseMs: 500,
  parkRetryCapMs: 900_000,
};

export type SagaCommandDispatchOutcome = 'sent' | 'parked' | 'rejected' | 'noop';

export interface SagaCommandParkContext {
  readonly attempts: number;
  readonly lastError: string;
}

/**
 * OR3's "at most once per row" hook (`observability_reliability`
 * design.md §4.2) — called ONLY when `store.park(...)` performed the
 * transition AND `store.claimDeadLetter(...)` claimed the row (this
 * call's the row's FIRST park; a later re-park of an already-dead-
 * lettered row never reaches this hook). Kept as a narrow, separately
 * injected collaborator — not four new constructor parameters on
 * `SagaCommandDispatcher` itself — so `SagaCommandDispatcher`'s own
 * retry/park mechanism (SO4/SO5, unmodified by this feature) and its
 * existing tests/call sites are untouched by a feature this dispatcher
 * does not otherwise need to know the shape of.
 */
export interface HandlesFirstPark {
  onFirstPark(row: SagaCommandRecord, context: SagaCommandParkContext): Promise<void>;
}

const NOOP_FIRST_PARK_HANDLER: HandlesFirstPark = {
  async onFirstPark(): Promise<void> {
    /* no-op default — OR3 is opt-in via the constructor's last parameter */
  },
};

export const SAGA_COMMAND_DISPATCHER = Symbol('SagaCommandDispatcher');

/** The one method a caller needs from `SagaCommandDispatcher` — decoupled from the concrete class so `Issue…Command` handlers and the sweeper can each be tested against a controllable fake. */
export interface DispatchesSagaCommands {
  dispatch(orderId: UniqueId, command: SagaCommandKind): Promise<SagaCommandDispatchOutcome>;
}

export interface Delay {
  (ms: number): Promise<void>;
}

const realDelay: Delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SagaCommandDispatcherLogger {
  info(message: string, meta: Record<string, unknown>): void;
  error(message: string, meta: Record<string, unknown>): void;
}

const CONSOLE_LOGGER: SagaCommandDispatcherLogger = {
  info: (message, meta) => console.log(JSON.stringify({ level: 'info', message, ...meta })),
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};

function callFor(
  port: SagaCommandsPort,
  command: SagaCommandKind,
): (payload: SagaCommandPayload, meta: SagaCommandMeta) => Promise<unknown> {
  switch (command) {
    case 'stock.reserve':
      return (payload, meta) => port.reserveStock(payload as Parameters<SagaCommandsPort['reserveStock']>[0], meta);
    case 'stock.release':
      return (payload, meta) => port.releaseStock(payload as Parameters<SagaCommandsPort['releaseStock']>[0], meta);
    case 'despatch.create':
      return (payload, meta) => port.createDespatch(payload as Parameters<SagaCommandsPort['createDespatch']>[0], meta);
    case 'credit.hold':
      return (payload, meta) => port.holdCredit(payload as Parameters<SagaCommandsPort['holdCredit']>[0], meta);
    case 'invoice.issue':
      return (payload, meta) => port.issueInvoice(payload as Parameters<SagaCommandsPort['issueInvoice']>[0], meta);
    case 'credit.release':
      return (payload, meta) => port.releaseCredit(payload as Parameters<SagaCommandsPort['releaseCredit']>[0], meta);
    default: {
      const exhaustive: never = command;
      throw new Error(`saga-command-dispatcher: unmapped saga command kind "${String(exhaustive)}"`);
    }
  }
}

export class SagaCommandDispatcher implements DispatchesSagaCommands {
  constructor(
    private readonly commands: SagaCommandsPort,
    private readonly store: SagaCommandStore,
    private readonly config: SagaCommandDispatcherConfig = DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG,
    private readonly delay: Delay = realDelay,
    private readonly logger: SagaCommandDispatcherLogger = CONSOLE_LOGGER,
    private readonly firstParkHandler: HandlesFirstPark = NOOP_FIRST_PARK_HANDLER,
  ) {}

  /**
   * Claims `(orderId, command)`'s pending/parked row and runs the SO4
   * retry policy. Absent or already `sent` — a stale hop — is a silent
   * no-op (design.md §5.5): the unique key and this claim make
   * double-dispatch harmless on top of the responders' own idempotency
   * (saga.md §6 layer 3). A TERMINAL business rejection (feature 42 —
   * `SagaCommandBusinessRejectionError`) short-circuits the retry loop
   * on its first occurrence, skipping remaining attempts/backoff and
   * `park()`'s retry-eligible path entirely, resolving instead to
   * `markRejected`'s terminal `rejected` status.
   */
  async dispatch(orderId: UniqueId, command: SagaCommandKind): Promise<SagaCommandDispatchOutcome> {
    const row = await this.store.findByOrderAndCommand(orderId, command);
    if (!row || row.status === 'sent') {
      return 'noop';
    }

    const call = callFor(this.commands, command);
    // FS2: correlationId is the order id, requestId is the row id — both
    // stable across every in-line retry and sweeper re-issue of this row
    // (asyncapi.yaml RpcHeaders: "a retry after a timeout reuses the same
    // value, which is what lets a responder recognise a duplicate").
    const meta: SagaCommandMeta = { correlationId: orderId, requestId: row.id };
    let lastError = '';
    let attemptsThisCycle = 0;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      attemptsThisCycle = attempt;
      try {
        await call(row.payload, meta);
        const sent = await this.store.markSent(row.id);
        if (sent) {
          const sentTraceId = activeTraceId();
          this.logger.info('saga-command-dispatcher: command sent', {
            orderId: orderId.value,
            correlationId: orderId.value,
            ...(sentTraceId ? { traceId: sentTraceId } : {}),
            command,
            attempts: row.attempts + attemptsThisCycle,
          });
        }
        return 'sent';
      } catch (error) {
        // Feature 42: a terminal business rejection short-circuits the
        // retry loop immediately — no further in-line attempts, no
        // backoff delay, and NOT `park()`'s retry-eligible path. The
        // responder has already given a definitive "no" from its own
        // domain (e.g. `PRECONDITION_FAILED`); a second/third attempt at
        // the same subject with the same idempotent request id can only
        // ever reproduce the identical rejection, so retrying it is pure
        // waste — and, before this fix, an unresolvable infinite retry.
        if (error instanceof SagaCommandBusinessRejectionError) {
          const totalAttempts = row.attempts + attemptsThisCycle;
          await this.store.markRejected(row.id, totalAttempts, error.message);
          const rejectedTraceId = activeTraceId();
          this.logger.error('saga-command-dispatcher: terminal business rejection, command rejected', {
            orderId: orderId.value,
            correlationId: orderId.value,
            ...(rejectedTraceId ? { traceId: rejectedTraceId } : {}),
            command,
            attempts: totalAttempts,
            rpcErrorCode: error.rpcErrorCode,
            error: error.message,
          });
          return 'rejected';
        }
        lastError =
          error instanceof SagaCommandTimeoutError || error instanceof SagaCommandTransportError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        if (attempt < this.config.maxAttempts) {
          await this.delay(this.config.backoffBaseMs * 2 ** (attempt - 1));
        }
      }
    }

    const totalAttempts = row.attempts + attemptsThisCycle;
    const parkCycles = Math.floor(totalAttempts / this.config.maxAttempts);
    const backoffMs = Math.min(30_000 * 2 ** Math.max(0, parkCycles - 1), this.config.parkRetryCapMs);
    const nextAttemptAt = new Date(Date.now() + backoffMs);

    const wasParked = await this.store.park(row.id, totalAttempts, lastError, nextAttemptAt);
    const parkedTraceId = activeTraceId();
    this.logger.error('saga-command-dispatcher: exhausted attempts, command parked', {
      orderId: orderId.value,
      correlationId: orderId.value,
      ...(parkedTraceId ? { traceId: parkedTraceId } : {}),
      command,
      attempts: totalAttempts,
      error: lastError,
      nextAttemptAt: nextAttemptAt.toISOString(),
    });

    // OR3 — "at most once per row": `claimDeadLetter` is itself the
    // guard (`WHERE dead_lettered_at IS NULL`), so a racing/later sweep
    // cycle that re-parks an already-dead-lettered row never reaches
    // `onFirstPark` a second time. `wasParked === false` means a
    // concurrent dispatcher already reported this row `sent` — SO5's own
    // race-safety, unrelated to dead-lettering, but dead-lettering a row
    // that just turned out to have succeeded would be wrong regardless.
    if (wasParked) {
      const claimed = await this.store.claimDeadLetter(row.id);
      if (claimed) {
        await this.firstParkHandler.onFirstPark(row, { attempts: totalAttempts, lastError });
      }
    }

    return 'parked';
  }
}
