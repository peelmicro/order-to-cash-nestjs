// The durability backstop (SO3, SO5; design.md §6.4) — structurally
// identical to `OutboxRelayService` (outbox-relay.service.ts): a
// self-scheduling `setTimeout` chain, never `setInterval`, so overlapping
// cycles are structurally impossible; graceful shutdown awaits the
// in-flight cycle. Claims in one short transaction (via the injected
// `UnitOfWork`), then dispatches EACH claimed row outside that
// transaction, calling the dispatcher DIRECTLY — never through the
// `CommandBus` (design.md §5.5: "the sweeper is the durability backstop
// and must not depend on the in-memory layer").
import { Inject, Injectable, Optional, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { CLOCK, type Clock } from '../../application/ports/clock.port';
import { SAGA_COMMAND_STORE, type SagaCommandStore } from '../../application/ports/saga-command-store.port';
import { UNIT_OF_WORK, type UnitOfWork } from '../../application/ports/unit-of-work.port';
import { SAGA_COMMAND_DISPATCHER, type DispatchesSagaCommands } from './saga-command-dispatcher';

export const SAGA_COMMAND_SWEEPER_CONFIG = Symbol('SagaCommandSweeperConfig');

export interface SagaCommandSweeperConfig {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly pendingGraceMs: number;
  /** Not one of the four env settings design.md §6.4 tables — an internal cap on rows claimed per cycle, the same shape `OUTBOX_BATCH_SIZE` gives the relay. */
  readonly batchLimit: number;
}

export interface SagaCommandSweeperLogger {
  error(message: string, meta: Record<string, unknown>): void;
}

const CONSOLE_LOGGER: SagaCommandSweeperLogger = {
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};

@Injectable()
export class SagaCommandSweeperService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private readonly logger: SagaCommandSweeperLogger;

  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(SAGA_COMMAND_STORE) private readonly store: SagaCommandStore,
    @Inject(SAGA_COMMAND_DISPATCHER) private readonly dispatcher: DispatchesSagaCommands,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SAGA_COMMAND_SWEEPER_CONFIG) private readonly config: SagaCommandSweeperConfig,
    // `@Optional()` — NOT a parameter property, so the DI-tokens ESLint
    // rule does not apply, but Nest's own container still reflects a
    // constructor-parameter count of 6 and would otherwise throw
    // "can't resolve dependencies" for an interface-typed param with no
    // registered provider; `@Optional()` makes Nest pass `undefined` when
    // unresolved, so the default value below applies exactly as it would
    // in a plain `new SagaCommandSweeperService(...)` unit test.
    @Optional() logger: SagaCommandSweeperLogger = CONSOLE_LOGGER,
  ) {
    this.logger = logger ?? CONSOLE_LOGGER;
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      return;
    }
    this.scheduleNext(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.runCycle();
    }, delayMs);
  }

  private async runCycle(): Promise<void> {
    try {
      const claimed = await this.unitOfWork.execute((tx) =>
        this.store.claimDue(tx, this.clock.now(), this.config.batchLimit, {
          pendingGraceMs: this.config.pendingGraceMs,
        }),
      );

      for (const row of claimed) {
        try {
          await this.dispatcher.dispatch(row.orderId, row.command);
        } catch (error) {
          this.logger.error('saga-command-sweeper: dispatch of a claimed row threw', {
            orderId: row.orderId.value,
            command: row.command,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.logger.error('saga-command-sweeper: claim cycle failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight = null;
      if (!this.stopped) {
        this.scheduleNext(this.config.intervalMs);
      }
    }
  }
}
