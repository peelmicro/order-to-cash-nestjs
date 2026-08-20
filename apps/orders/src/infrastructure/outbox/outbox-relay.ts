// The relay's core — design.md §5.1, §5.2. A PLAIN CLASS, no NestJS
// decorator: `runOnce()` is directly callable from a test without a Nest
// application context, and `apps/seed`'s integration spec imports it to
// prove the seeded databases have nothing to publish (H1).
import { asc, inArray, isNull } from 'drizzle-orm';
import type { Clock } from '../../application/ports/clock.port';
import type { FactPublisher, PublishableFact } from '../../application/ports/fact-publisher.port';
import type { OrdersDb } from '../persistence/client';
import { outbox } from '../persistence/schema';
import type { OutboxRelayConfig } from './outbox-relay.config';
import { outboxRowToEnvelope } from './outbox-envelope-mapper';

export interface OutboxRelayResult {
  readonly claimed: number;
  readonly published: number;
}

export interface OutboxRelayLogger {
  error(message: string, meta: Record<string, unknown>): void;
}

const CONSOLE_LOGGER: OutboxRelayLogger = {
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};

export interface OutboxRelayDeps {
  readonly db: OrdersDb;
  readonly publisher: FactPublisher;
  readonly clock: Clock;
  readonly config: OutboxRelayConfig;
  readonly logger?: OutboxRelayLogger;
}

export class OutboxRelay {
  private readonly db: OrdersDb;
  private readonly publisher: FactPublisher;
  private readonly clock: Clock;
  private readonly config: OutboxRelayConfig;
  private readonly logger: OutboxRelayLogger;

  constructor(deps: OutboxRelayDeps) {
    this.db = deps.db;
    this.publisher = deps.publisher;
    this.clock = deps.clock;
    this.config = deps.config;
    this.logger = deps.logger ?? CONSOLE_LOGGER;
  }

  /**
   * One complete cycle: claim -> publish -> stamp, in one write-model
   * transaction (design.md §5.2). Claim: `WHERE published_at IS NULL
   * ORDER BY seq ASC LIMIT :batch FOR UPDATE SKIP LOCKED` — never a stored
   * cursor (OI3). Stamp only after the broker acknowledges every fact
   * (R14); a rejected batch is left entirely unstamped and is retried,
   * unchanged, on the next poll (OI8).
   */
  async runOnce(): Promise<OutboxRelayResult> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx
        .select()
        .from(outbox)
        .where(isNull(outbox.publishedAt))
        .orderBy(asc(outbox.seq))
        .limit(this.config.batchSize)
        .for('update', { skipLocked: true });

      if (claimed.length === 0) {
        return { claimed: 0, published: 0 };
      }

      const facts: PublishableFact[] = claimed.map((row) => {
        const envelope = outboxRowToEnvelope(row);
        const headers: Record<string, string> = {
          'x-event-type': envelope.eventType,
          'content-type': 'application/json',
        };
        // traceparent only if the stored/ambient context supplies one
        // (design.md §3.3) — this feature writes trace_parent NULL, so the
        // header is omitted until feature 27 populates the column.
        if (row.traceParent) {
          headers.traceparent = row.traceParent;
        }
        return { key: envelope.correlationId, envelope, headers };
      });

      try {
        await this.publisher.publish(facts);
      } catch (error) {
        for (const row of claimed) {
          this.logger.error('outbox-relay: publish failed, batch left unstamped for the next poll', {
            correlationId: row.correlationId,
            eventId: row.eventId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Nothing was written before this point (the SELECT ... FOR UPDATE
        // above takes no rows out of the unpublished set), so letting the
        // transaction complete without the stamp below is equivalent to a
        // rollback for every column that matters (OI8): the same records
        // are found, in the same order, on the very next poll.
        return { claimed: claimed.length, published: 0 };
      }

      await tx
        .update(outbox)
        .set({ publishedAt: this.clock.now() })
        .where(
          inArray(
            outbox.id,
            claimed.map((row) => row.id),
          ),
        );

      return { claimed: claimed.length, published: claimed.length };
    });
  }
}
