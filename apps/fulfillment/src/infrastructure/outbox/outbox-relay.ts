// COPY OF — apps/orders/src/infrastructure/outbox/outbox-relay.ts
// The relay's core — design.md §5.1, §5.2. A PLAIN CLASS, no NestJS
// decorator: `runOnce()` is directly callable from a test without a Nest
// application context, and `apps/seed`'s integration spec imports it to
// prove the seeded databases have nothing to publish (H1).
//
// observability_dashboards (phase 22) widens this copy to ALSO create the
// manual "outbox.publish" span apps/orders' own relay already does — a
// genuine gap this phase's live-trace verification found: this service
// forwarded a row's stored `trace_parent` verbatim as the outbound Kafka
// header (a correct trace ID) but attached no span of its own to it, so
// `stock.reserved.v1`/`order.despatched.v1` facts carried the right trace
// but fulfillment never appeared as a participant in Jaeger. Same shape,
// same "only for a row that stored a traceParent" guard, same "the span's
// OWN fresh span id, not the raw stored value, is what gets injected into
// the outgoing header" contract as apps/orders' own relay — see that
// file's header comment for the full reasoning.
import { propagation, SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import { asc, inArray, isNull } from 'drizzle-orm';
import type { Clock } from '../../application/ports/clock.port';
import type { FactPublisher, PublishableFact } from '../../application/ports/fact-publisher.port';
import { contextFromTraceParent, startChildSpan } from '../observability/trace-context';
import type { WriteModelDb } from '../persistence/client';
import { outbox } from '../persistence/schema';
import type { OutboxRelayConfig } from './outbox-relay.config';
import { outboxRowToEnvelope } from './outbox-envelope-mapper';

export interface OutboxRelayResult {
  readonly claimed: number;
  readonly published: number;
}

/** Raised when `publisher.publish(...)` has not settled within `config.publishTimeoutMs` — design.md §5.2's stated bound on the open claim transaction (fixes defect D1: the config value was parsed but never enforced). Handled the same way any other publish failure is (§5.3, OI8): the batch is left unstamped and retried, unchanged, on the next poll. */
export class OutboxPublishTimeoutError extends Error {
  constructor(timeoutMs: number, batchSize: number) {
    super(`outbox-relay: publish of ${batchSize} fact(s) did not settle within OUTBOX_PUBLISH_TIMEOUT_MS=${timeoutMs}`);
    this.name = new.target.name;
  }
}

function withPublishTimeout(publish: Promise<void>, timeoutMs: number, batchSize: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OutboxPublishTimeoutError(timeoutMs, batchSize)), timeoutMs);
    publish.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

export interface OutboxRelayLogger {
  error(message: string, meta: Record<string, unknown>): void;
}

const CONSOLE_LOGGER: OutboxRelayLogger = {
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};

export interface OutboxRelayDeps {
  readonly db: WriteModelDb;
  readonly publisher: FactPublisher;
  readonly clock: Clock;
  readonly config: OutboxRelayConfig;
  readonly logger?: OutboxRelayLogger;
}

export class OutboxRelay {
  private readonly db: WriteModelDb;
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

      // observability_dashboards (phase 22) — the outbox relay's publish
      // call is now, like apps/orders' own relay, one of this service's own
      // manual span points (kafkajs has no OTel auto-instrumentation). A
      // span is created only for a row that stored a `traceParent` at
      // write time (`outbox-recorder.ts` — a caller that never extracted/
      // continued a trace has none to continue here either, so the header
      // is omitted, exactly the prior behaviour for an untraced row). The
      // span's OWN (fresh) span id — not the raw stored value — is what
      // gets injected into the outgoing Kafka header, so a consumer's
      // extracted "parent" is this publish span, not the row's original
      // writer.
      const spans: Array<Span | undefined> = [];
      const facts: PublishableFact[] = claimed.map((row) => {
        const envelope = outboxRowToEnvelope(row);
        const headers: Record<string, string> = {
          'x-event-type': envelope.eventType,
          'content-type': 'application/json',
        };
        let span: Span | undefined;
        if (row.traceParent) {
          const parentContext = contextFromTraceParent(row.traceParent);
          const started = startChildSpan(`outbox.publish ${envelope.eventType}`, parentContext, SpanKind.PRODUCER);
          span = started.span;
          propagation.inject(started.spanContext, headers);
        }
        spans.push(span);
        return { key: envelope.correlationId, envelope, headers };
      });

      try {
        // Bounds the open claim transaction by OUTBOX_PUBLISH_TIMEOUT_MS
        // (design.md §5.2) — a producer that never settles (broker
        // unreachable, hung TCP connection) must not hold the claimed rows'
        // locks indefinitely; a timeout is handled exactly like any other
        // publish failure below (OI8: left unstamped, retried unchanged).
        await withPublishTimeout(this.publisher.publish(facts), this.config.publishTimeoutMs, claimed.length);
      } catch (error) {
        claimed.forEach((row, index) => {
          const traceId = spans[index]?.spanContext().traceId;
          this.logger.error('outbox-relay: publish failed, batch left unstamped for the next poll', {
            correlationId: row.correlationId,
            eventId: row.eventId,
            error: error instanceof Error ? error.message : String(error),
            ...(traceId ? { traceId } : {}),
          });
        });
        for (const span of spans) {
          span?.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
          span?.end();
        }
        // Nothing was written before this point (the SELECT ... FOR UPDATE
        // above takes no rows out of the unpublished set), so letting the
        // transaction complete without the stamp below is equivalent to a
        // rollback for every column that matters (OI8): the same records
        // are found, in the same order, on the very next poll.
        return { claimed: claimed.length, published: 0 };
      }

      for (const span of spans) {
        span?.end();
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
