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
import type { SagaCommandStore } from '../../application/ports/saga-command-store.port';
import {
  SagaCommandTimeoutError,
  SagaCommandTransportError,
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

export type SagaCommandDispatchOutcome = 'sent' | 'parked' | 'noop';

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
): (payload: SagaCommandPayload) => Promise<unknown> {
  switch (command) {
    case 'stock.reserve':
      return (payload) => port.reserveStock(payload as Parameters<SagaCommandsPort['reserveStock']>[0]);
    case 'stock.release':
      return (payload) => port.releaseStock(payload as Parameters<SagaCommandsPort['releaseStock']>[0]);
    case 'despatch.create':
      return (payload) => port.createDespatch(payload as Parameters<SagaCommandsPort['createDespatch']>[0]);
    case 'credit.hold':
      return (payload) => port.holdCredit(payload as Parameters<SagaCommandsPort['holdCredit']>[0]);
    case 'invoice.issue':
      return (payload) => port.issueInvoice(payload as Parameters<SagaCommandsPort['issueInvoice']>[0]);
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
  ) {}

  /**
   * Claims `(orderId, command)`'s pending/parked row and runs the SO4
   * retry policy. Absent or already `sent` — a stale hop — is a silent
   * no-op (design.md §5.5): the unique key and this claim make
   * double-dispatch harmless on top of the responders' own idempotency
   * (saga.md §6 layer 3).
   */
  async dispatch(orderId: UniqueId, command: SagaCommandKind): Promise<SagaCommandDispatchOutcome> {
    const row = await this.store.findByOrderAndCommand(orderId, command);
    if (!row || row.status === 'sent') {
      return 'noop';
    }

    const call = callFor(this.commands, command);
    let lastError = '';
    let attemptsThisCycle = 0;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      attemptsThisCycle = attempt;
      try {
        await call(row.payload);
        const sent = await this.store.markSent(row.id);
        if (sent) {
          this.logger.info('saga-command-dispatcher: command sent', {
            orderId: orderId.value,
            command,
            attempts: row.attempts + attemptsThisCycle,
          });
        }
        return 'sent';
      } catch (error) {
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

    await this.store.park(row.id, totalAttempts, lastError, nextAttemptAt);
    this.logger.error('saga-command-dispatcher: exhausted attempts, command parked', {
      orderId: orderId.value,
      command,
      attempts: totalAttempts,
      error: lastError,
      nextAttemptAt: nextAttemptAt.toISOString(),
    });
    return 'parked';
  }
}
