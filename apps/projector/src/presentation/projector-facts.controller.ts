// Three `@EventPattern` Kafka consumers, one per fact topic — same shape
// apps/notifications/src/presentation/notification-facts.controller.ts
// establishes, but this service dispatches ALL THIRTEEN facts
// unconditionally (design-model.md §7.3: the projector is the only
// consumer that must). This service answers no RPC and emits no fact:
// main.ts connects EXACTLY ONE microservice transport, `Transport.KAFKA`,
// for these three handlers.
//
// Each `@EventPattern` is bound to `Transport.KAFKA` EXPLICITLY (CLAUDE.md §
// Non-negotiables — a bare pattern binds to EVERY connected transport).
//
// OR1/A4b (observability_reliability design.md §4.1) — `route`'s dispatch
// point is now wrapped by `FactRetryDispatcher`: the SAME
// `commandBus.execute(...)` call as before, retried in-line with backoff,
// dead-lettered to `<topic>.dlq` (and the offset still committed) only on
// exhaustion. `UnknownFactTypeError`'s PR4 log-and-ack branch is caught
// and swallowed INSIDE the wrapped `process` callback, before it ever
// reaches the retry dispatcher — an unrecognised eventType is a producer-
// bug shape exactly like a malformed envelope, not repairable by retry,
// so it stays a plain ack (unchanged from before this feature). Only a
// genuine processing failure (a Mongo write failure, or — as this
// service's own poison-message incident would have been — a required
// payload field missing deep inside a summary builder, past the
// envelope-shape guard) is retried and, on exhaustion, dead-lettered; see
// projector-dead-letter.integration.spec.ts's own incident reproduction.
import { Controller, Inject, Optional } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Ctx, EventPattern, KafkaContext, Payload, Transport } from '@nestjs/microservices';
import { context as otelContext, SpanKind } from '@opentelemetry/api';
import type { Envelope } from '@otc/contracts';
import { UnknownFactTypeError } from '../domain/fact-projection';
import { ProjectFactCommand } from '../application/commands/project-fact.command';
import { FACT_RETRY_DISPATCHER, type DispatchesFactRetries } from '../infrastructure/messaging/fact-retry-dispatcher';
import {
  activeTraceId,
  extractKafkaTraceContext,
  startChildSpan,
  type KafkaHeaderCarrier,
} from '../infrastructure/observability/trace-context';
import {
  BILLING_FACTS_TOPIC,
  FULFILLMENT_FACTS_TOPIC,
  ORDERS_FACTS_TOPIC,
} from '../infrastructure/messaging/kafka.config';

export class MalformedFactEnvelopeError extends Error {
  constructor(reason: string) {
    super(`projector-facts.controller: malformed fact envelope — ${reason}`);
    this.name = new.target.name;
  }
}

const REQUIRED_ENVELOPE_FIELDS = [
  'eventId',
  'eventType',
  'aggregateId',
  'correlationId',
  'causationId',
  'occurredAt',
  'payload',
] as const;

/** Narrows an inbound Kafka message value to `Envelope` — same tolerant Buffer/string/object handling as notification-facts.controller.ts's `parseFactEnvelope`. */
export function parseFactEnvelope(value: unknown): Envelope {
  let candidate: unknown = value;
  if (Buffer.isBuffer(candidate) || typeof candidate === 'string') {
    const text = Buffer.isBuffer(candidate) ? candidate.toString('utf8') : candidate;
    try {
      candidate = JSON.parse(text);
    } catch (error) {
      throw new MalformedFactEnvelopeError(
        `value is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (typeof candidate !== 'object' || candidate === null) {
    throw new MalformedFactEnvelopeError('value is not an object');
  }

  const missing = REQUIRED_ENVELOPE_FIELDS.filter(
    (field) => (candidate as Record<string, unknown>)[field] == null,
  );
  if (missing.length > 0) {
    throw new MalformedFactEnvelopeError(`missing required field(s): ${missing.join(', ')}`);
  }

  return candidate as Envelope;
}

export interface ProjectorFactsControllerLogger {
  error(message: string, meta: Record<string, unknown>): void;
}

// R58 closeout (design.md §4.4, Phase 25 traceability audit
// `progress/review_traceability_audit.md` §3) — alongside `message`/`meta`,
// read from the ACTIVE span, same formula as `saga-facts.controller.ts`'s
// own CONSOLE_LOGGER: `route`'s malformed-envelope branch below now
// extracts-and-continues the inbound message's OWN trace context BEFORE
// parsing, so a producer bug in an otherwise well-traced fact still logs
// its real originating traceId; a message with no `traceparent` header (or
// no OTel provider registered, e.g. a plain unit test) yields `undefined`,
// and the key is omitted entirely.
const CONSOLE_LOGGER: ProjectorFactsControllerLogger = {
  error: (message, meta) => {
    const traceId = activeTraceId();
    console.error(JSON.stringify({ level: 'error', message, ...meta, ...(traceId ? { traceId } : {}) }));
  },
};

@Controller()
export class ProjectorFactsController {
  private readonly logger: ProjectorFactsControllerLogger;

  constructor(
    @Inject(CommandBus) private readonly commandBus: CommandBus,
    @Inject(FACT_RETRY_DISPATCHER) private readonly retryDispatcher: DispatchesFactRetries,
    // @Optional() — without it, Nest's container tries (and fails) to
    // resolve an interface-typed parameter with no registered provider
    // (same reasoning as notification-facts.controller.ts's constructor).
    @Optional() logger: ProjectorFactsControllerLogger = CONSOLE_LOGGER,
  ) {
    this.logger = logger ?? CONSOLE_LOGGER;
  }

  @EventPattern(ORDERS_FACTS_TOPIC, Transport.KAFKA)
  async onOrdersFact(@Payload() payload: unknown, @Ctx() kafkaContext: KafkaContext): Promise<void> {
    await this.route(ORDERS_FACTS_TOPIC, payload, kafkaContext);
  }

  @EventPattern(FULFILLMENT_FACTS_TOPIC, Transport.KAFKA)
  async onFulfillmentFact(@Payload() payload: unknown, @Ctx() kafkaContext: KafkaContext): Promise<void> {
    await this.route(FULFILLMENT_FACTS_TOPIC, payload, kafkaContext);
  }

  @EventPattern(BILLING_FACTS_TOPIC, Transport.KAFKA)
  async onBillingFact(@Payload() payload: unknown, @Ctx() kafkaContext: KafkaContext): Promise<void> {
    await this.route(BILLING_FACTS_TOPIC, payload, kafkaContext);
  }

  private async route(topic: string, payload: unknown, kafkaContext: KafkaContext): Promise<void> {
    // OR4/R57 (design.md §4.3), widened for R58 closeout (design.md §4.4,
    // Phase 25 traceability audit
    // `progress/review_traceability_audit.md` §3): extracted BEFORE
    // `parseFactEnvelope` runs (not only after) — the inbound Kafka
    // message's headers are readable regardless of whether ITS PAYLOAD
    // parses, so a producer bug that still carried a real `traceparent`
    // (every fact this fleet's own outbox relays publish does) lets even
    // the malformed-envelope log-and-ack branch below log its real
    // originating traceId — same widening `saga-facts.controller.ts`'s own
    // R58 closeout already made.
    const headers = kafkaContext.getMessage().headers as KafkaHeaderCarrier | undefined;
    const extracted = extractKafkaTraceContext(headers);

    let envelope: Envelope;
    try {
      envelope = parseFactEnvelope(payload);
    } catch (error) {
      // PR3 — log-and-ack: a malformed value cannot be projected, and
      // redelivery cannot fix a producer bug. No `correlationId` is logged
      // here — a malformed envelope has no trustworthy `correlationId` to
      // attach (same, pre-existing, by-design omission
      // `saga-facts.controller.ts`'s own malformed-envelope branch
      // documents), not a gap this closeout introduces.
      await otelContext.with(extracted, async () => {
        this.logger.error(
          'projector-facts.controller: malformed fact envelope, acknowledged without processing',
          { topic, error: error instanceof Error ? error.message : String(error) },
        );
      });
      return;
    }

    // OR4/R57 (design.md §4.3) — the fact-consume entry point is one of
    // the two points this feature creates a manual span at. Continues from
    // the SAME `extracted` context above (the `traceparent` the outbox
    // relay of the PRODUCING service injected) and wraps the whole
    // retry-then-DLQ dispatch below in it, so every retry attempt AND any
    // eventual DLQ publish (`kafka-dlq-publisher.ts`) share the same trace
    // id as the fact that triggered them.
    const { span, spanContext } = startChildSpan(`fact.consume ${envelope.eventType}`, extracted, SpanKind.CONSUMER);

    // OR1/A4b — retried in-line with backoff, dead-lettered (offset still
    // committed) only on exhaustion. `UnknownFactTypeError` is caught and
    // swallowed HERE, inside `process`, so it never reaches the retry
    // dispatcher at all (PR4's log-and-ack, unchanged).
    try {
      await otelContext.with(spanContext, () =>
        this.retryDispatcher.dispatch(topic, envelope, 'projector', async (env) => {
          try {
            await this.commandBus.execute(new ProjectFactCommand(env));
          } catch (error) {
            if (error instanceof UnknownFactTypeError) {
              // PR4 — log-and-ack, NOT a silent discard: an unknown eventType is
              // visible in the logs, but is never repairable by redelivery.
              // R58 closeout — `correlationId` is the parsed envelope's own
              // (always present here, unlike the malformed-envelope branch
              // above); `traceId` comes from the ACTIVE span this call
              // still runs inside (CONSOLE_LOGGER's own `activeTraceId()`).
              this.logger.error(
                'projector-facts.controller: unknown eventType, acknowledged without processing',
                { topic, eventType: env.eventType, eventId: env.eventId, correlationId: env.correlationId },
              );
              return;
            }
            // Every other failure (a Mongo write failure, or a payload
            // malformed past the envelope-shape guard) propagates out of
            // `process` so `FactRetryDispatcher` retries it, then dead-letters
            // on exhaustion (PR6's own note: idempotency is a property of the
            // query, so redelivery/retry is always safe).
            throw error;
          }
        }),
      );
    } finally {
      span.end();
    }
  }
}
