// COPY OF — apps/orders/src/infrastructure/outbox/outbox-relay.service.ts
// The thin `@Injectable()` NestJS wrapper around the plain `OutboxRelay`
// (design.md §5.1, §2): owns the interval loop and the lifecycle hooks, and
// nothing else — `runOnce()`'s own logic stays testable without a Nest
// application context.
//
// A SELF-SCHEDULING `setTimeout` chain, never `setInterval`: the next cycle
// is scheduled only once the previous one has settled, which is what makes
// overlapping cycles structurally impossible (OI6) instead of merely
// unlikely. `@nestjs/schedule` is deliberately not added — it is a
// dependency for one interval, and its intervals overlap under a slow
// tick, which is the exact failure this design refuses.
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { OutboxRelayResult } from './outbox-relay';
import type { OutboxRelayConfig } from './outbox-relay.config';

export const OUTBOX_RELAY = Symbol('OutboxRelay');
export const OUTBOX_RELAY_CONFIG = Symbol('OutboxRelayConfig');

/** The one method this service depends on — decoupled from the concrete `OutboxRelay` class so a test can supply a controllable fake. */
export interface RunsOutboxOnce {
  runOnce(): Promise<OutboxRelayResult>;
}

@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(
    @Inject(OUTBOX_RELAY) private readonly relay: RunsOutboxOnce,
    @Inject(OUTBOX_RELAY_CONFIG) private readonly config: OutboxRelayConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      return;
    }
    this.scheduleNext(0);
  }

  /** Clears the pending timer and awaits the in-flight cycle — no cycle is left running after shutdown resolves. */
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
      // Assigned BEFORE the cycle starts running, so a re-entrant call
      // arriving while it is in flight has something to observe (OI6).
      this.inFlight = this.runCycle();
    }, delayMs);
  }

  private async runCycle(): Promise<void> {
    try {
      await this.relay.runOnce();
    } finally {
      this.inFlight = null;
      if (!this.stopped) {
        this.scheduleNext(this.config.pollIntervalMs);
      }
    }
  }
}
