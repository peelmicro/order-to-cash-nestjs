// Three `@EventPattern` Kafka consumers, one per fact topic — same shape
// apps/orders/src/presentation/saga-facts.controller.ts establishes,
// adapted for a consumer with no unit of work: this service has no
// database, so there is no transactional boundary for `route` to defer to
// — `NotificationDispatchService` (application layer) owns idempotency
// entirely on its own (application/notification-dispatch.service.ts).
//
// This service answers no RPC and emits no fact: `main.ts` connects
// EXACTLY ONE microservice transport, `Transport.KAFKA`, for these three
// handlers — never NATS, never a second Kafka transport for anything else.
// If a future change adds a responder here, that is a scope violation of
// feature 23 (notifications_service's brief: "This service only
// consumes... If you find yourself adding one, stop and report").
//
// Each `@EventPattern` is bound to `Transport.KAFKA` EXPLICITLY (the
// decorator's second argument) — CLAUDE.md § Non-negotiables: a bare
// pattern binds to EVERY connected microservice transport, not just the one
// it was written for (the live-stack bug `saga-facts.controller.ts`'s
// header records). This service only ever connects one transport, but the
// explicit argument stays — cheap insurance against the same bug if a
// second transport is ever added by mistake, and the ESLint
// `no-restricted-syntax` guard enforces it regardless.
//
// OR1/A4b (observability_reliability design.md §4.1) — `route`'s dispatch
// point is now wrapped by `FactRetryDispatcher`: the SAME
// `commandBus.execute(...)` call as before, retried in-line with backoff,
// dead-lettered to `<topic>.dlq` (and the offset still committed) only on
// exhaustion. A syntactically malformed envelope is still handled entirely
// by the pre-existing, unwrapped `parseFactEnvelope` log-and-ack path
// above — this wrapper only widens what happens after a syntactically
// valid envelope fails semantically deep inside a template builder (a
// missing `retailerCode`, for instance — see
// notification-dead-letter.integration.spec.ts's own incident
// reproduction).
import { Controller, Inject, Optional } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Ctx, EventPattern, KafkaContext, Payload, Transport } from '@nestjs/microservices';
import { context as otelContext, SpanKind } from '@opentelemetry/api';
import type { Envelope } from '@otc/contracts';
import { notifyCommandFor } from '../application/commands/notify.commands';
import { FACT_RETRY_DISPATCHER, type DispatchesFactRetries } from '../infrastructure/messaging/fact-retry-dispatcher';
import { extractKafkaTraceContext, startChildSpan, type KafkaHeaderCarrier } from '../infrastructure/observability/trace-context';
import {
  BILLING_FACTS_TOPIC,
  FULFILLMENT_FACTS_TOPIC,
  ORDERS_FACTS_TOPIC,
} from '../infrastructure/messaging/kafka.config';

export class MalformedFactEnvelopeError extends Error {
  constructor(reason: string) {
    super(`notification-facts.controller: malformed fact envelope — ${reason}`);
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

/**
 * Narrows an inbound Kafka message value to `Envelope` — same tolerant
 * Buffer/string/object handling as `saga-facts.controller.ts`'s
 * `parseFactEnvelope` (the default Kafka deserializer has usually already
 * JSON-parsed the value by the time `@Payload()` hands it here, but a raw
 * value or a parse failure upstream is handled too).
 */
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

export interface NotificationFactsControllerLogger {
  error(message: string, meta: Record<string, unknown>): void;
}

const CONSOLE_LOGGER: NotificationFactsControllerLogger = {
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};

@Controller()
export class NotificationFactsController {
  private readonly logger: NotificationFactsControllerLogger;

  constructor(
    @Inject(CommandBus) private readonly commandBus: CommandBus,
    @Inject(FACT_RETRY_DISPATCHER) private readonly retryDispatcher: DispatchesFactRetries,
    // `@Optional()` — same reasoning as saga-facts.controller.ts's
    // constructor comment: without it, Nest's container tries (and fails)
    // to resolve an interface-typed parameter with no registered provider.
    @Optional() logger: NotificationFactsControllerLogger = CONSOLE_LOGGER,
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
    let envelope: Envelope;
    try {
      envelope = parseFactEnvelope(payload);
    } catch (error) {
      // Log-and-ack: a malformed value cannot be deduped or notified about,
      // and redelivery cannot fix a producer bug. Returning normally lets
      // the Kafka offset commit — same policy as saga-facts.controller.ts.
      this.logger.error(
        'notification-facts.controller: malformed fact envelope, acknowledged without processing',
        { topic, error: error instanceof Error ? error.message : String(error) },
      );
      return;
    }

    const NotifyCommand = notifyCommandFor(envelope.eventType);
    if (!NotifyCommand) {
      // Not one of the seven notified facts (e.g. stock.reserved.v1,
      // credit.approved.v1, credit.released.v1, ...) — no CommandBus
      // dispatch, no dedup row, ack only. See notify.commands.ts's header.
      return;
    }

    // OR4/R57 (design.md §4.3) — the fact-consume entry point is one of
    // the two points this feature creates a manual span at. Extracts the
    // `traceparent` the outbox relay of the PRODUCING service injected and
    // wraps the whole retry-then-DLQ dispatch below in it, so every retry
    // attempt AND any eventual DLQ publish (`kafka-dlq-publisher.ts`)
    // share the same trace id as the fact that triggered them.
    const headers = kafkaContext.getMessage().headers as KafkaHeaderCarrier | undefined;
    const extracted = extractKafkaTraceContext(headers);
    const { span, spanContext } = startChildSpan(`fact.consume ${envelope.eventType}`, extracted, SpanKind.CONSUMER);

    // OR1/A4b — retried in-line with backoff, dead-lettered (offset still
    // committed) only on exhaustion. On success this resolves normally,
    // exactly as the bare `commandBus.execute(...)` call did before.
    try {
      await otelContext.with(spanContext, () =>
        this.retryDispatcher.dispatch(topic, envelope, 'notifications', async (env) => {
          await this.commandBus.execute(new NotifyCommand(env));
        }),
      );
    } finally {
      span.end();
    }
  }
}
