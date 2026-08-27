// The relay's core — design.md §5.1, §5.2. A PLAIN CLASS, no NestJS
// decorator: `runOnce()` is directly callable from a test without a Nest
// application context, and `apps/seed`'s integration spec imports it to
// prove the seeded databases have nothing to publish (H1).
import { propagation, SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import { asc, inArray, isNull } from 'drizzle-orm';
import type { Clock } from '../../application/ports/clock.port';
import type { FactPublisher, PublishableFact } from '../../application/ports/fact-publisher.port';
import { contextFromTraceParent, startChildSpan } from '../observability/trace-context';
import { dlqDepthGauge, outboxLagGauge } from '../observability/metrics';
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

/**
 * A7 (metrics, R59/OR5, design.md §4.5) — `otc_dlq_depth`'s own narrow
 * port: "a broker admin-client partition-offset query against each `.dlq`
 * topic." Optional on `OutboxRelayDeps` (defaults to recording nothing),
 * the SAME "narrow, separately injected, no-op default" shape a couple of
 * other observability collaborators elsewhere in this codebase already
 * establish, so every EXISTING `OutboxRelay` construction site (unit
 * tests, every other write model's unmodified copy of this file) keeps
 * working unchanged.
 */
export interface DlqDepthPort {
  /** Depth (message count) per topic, keyed by the exact string in `topics`. A topic this call could not resolve (e.g. not yet created) is simply absent from the returned map — the caller records 0 for it, never throws. */
  fetchDepths(topics: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

export interface OutboxRelayDeps {
  readonly db: WriteModelDb;
  readonly publisher: FactPublisher;
  readonly clock: Clock;
  readonly config: OutboxRelayConfig;
  readonly logger?: OutboxRelayLogger;
  /** A7's DLQ-depth collaborator — the caller's own topic NAMES are never hardcoded in this canonical file (OB1's own "names no service" check), so both the port AND the topic list are supplied by the caller. */
  readonly dlqDepth?: DlqDepthPort;
  readonly dlqTopics?: readonly string[];
}

export class OutboxRelay {
  private readonly db: WriteModelDb;
  private readonly publisher: FactPublisher;
  private readonly clock: Clock;
  private readonly config: OutboxRelayConfig;
  private readonly logger: OutboxRelayLogger;
  private readonly dlqDepth: DlqDepthPort | undefined;
  private readonly dlqTopics: readonly string[];

  constructor(deps: OutboxRelayDeps) {
    this.db = deps.db;
    this.publisher = deps.publisher;
    this.clock = deps.clock;
    this.config = deps.config;
    this.logger = deps.logger ?? CONSOLE_LOGGER;
    this.dlqDepth = deps.dlqDepth;
    this.dlqTopics = deps.dlqTopics ?? [];
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
    // A7 (metrics, R59/OR5, design.md §4.5) — `otc_outbox_lag_ms`: the age
    // of the OLDEST unpublished record, via a plain read (no row lock
    // needed for a gauge) using `idx_outbox_published_occurred` (design.md
    // §3.2/§4.5, the exact query this index was provisioned for — see
    // `outbox.schema.ts`'s own column comment). Measured BEFORE the claim
    // below so it reflects the backlog's age entering THIS poll cycle, not
    // whatever remains after this cycle's own batch publishes. 0 when the
    // outbox is fully caught up (never a negative value, never omitted).
    await this.recordOutboxLag();
    // A7 — `otc_dlq_depth`, "polled on the same interval as the outbox
    // relay" (design.md §4.5), literally: this method IS that interval's
    // own cycle body (`OutboxRelayService`'s self-scheduling loop).
    await this.recordDlqDepth();

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

      // OR4/R57 (design.md §4.3) — the outbox relay's publish call is one
      // of the two points this feature creates a MANUAL span at (kafkajs
      // has no OTel auto-instrumentation). A span is created only for a
      // row that stored a `traceParent` at write time (`outbox-recorder.ts`
      // — a caller that never extracted/continued a trace has none to
      // continue here either, so the header is omitted, exactly the prior
      // behaviour for an untraced row). The span's OWN (fresh) span id —
      // not the raw stored value — is what gets injected into the outgoing
      // Kafka header, so a consumer's extracted "parent" is this publish
      // span, not the row's original writer.
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
        // A6a (R58, design.md §4.4) — read PER ROW from that row's OWN
        // already-held span (`spans[index]`, built above), NOT the
        // ambient `trace.getActiveSpan()` every other call site this pass
        // touches uses: this loop logs one line per row in a single
        // batch, and a batch can genuinely mix rows from DIFFERENT
        // origin traces (or none at all, for a pre-feature-27/untraced
        // row) — there is no single "the" active span for the whole
        // catch block to read ambiently. Reading each span's own
        // `spanContext().traceId` directly is the same real, OTel-
        // generated id the ambient lookup would report if this loop
        // logged one row per `otelContext.with(...)` block instead; it is
        // simply the more correct read for a per-row loop. `undefined`
        // (key omitted, never the literal string `"undefined"`) for a row
        // whose `traceParent` was never stored (no span in `spans` at
        // that index) — the same "no trace to log honestly" case as
        // every other site.
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

  private async recordOutboxLag(): Promise<void> {
    const [oldest] = await this.db
      .select({ occurredAt: outbox.occurredAt })
      .from(outbox)
      .where(isNull(outbox.publishedAt))
      .orderBy(asc(outbox.occurredAt))
      .limit(1);
    const lagMs = oldest ? Math.max(0, this.clock.now().getTime() - oldest.occurredAt.getTime()) : 0;
    outboxLagGauge().record(lagMs);
  }

  private async recordDlqDepth(): Promise<void> {
    if (!this.dlqDepth || this.dlqTopics.length === 0) {
      return;
    }
    const depths = await this.dlqDepth.fetchDepths(this.dlqTopics);
    for (const topic of this.dlqTopics) {
      dlqDepthGauge().record(depths.get(topic) ?? 0, { topic });
    }
  }
}
