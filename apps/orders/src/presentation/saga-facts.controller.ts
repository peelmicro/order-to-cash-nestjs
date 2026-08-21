// Three `@EventPattern` Kafka consumers, one per fact topic (design.md
// §3.1, §3.3) — group `orders.saga` (main.ts), `fromBeginning: true` (SO1).
// Parses the envelope, routes through `factCommandFor` (self-produced
// facts are acknowledged with NO dispatch at all — SO2), and AWAITS
// `commandBus.execute(...)`: the fact `@CommandHandler` IS the entire
// transactional unit (design.md §5.1), so resolution means the transaction
// committed and rejection propagates unchanged to `@nestjs/microservices`'s
// throw -> no-offset-commit -> redeliver semantics (verified, task E3 —
// see main.ts's header comment for the finding).
//
// Each `@EventPattern` is bound to `Transport.KAFKA` EXPLICITLY (the
// decorator's second argument) — a real, live-stack-discovered bug
// (recorded in progress/impl_order_saga_orchestrator.md's "the Transport
// binding finding"): `ListenersController.registerPatternHandlers` binds
// any pattern with NO declared transport to EVERY connected microservice
// server, not just the one it was written for. Without this, the KAFKA
// server also received `orders-create.controller.ts`'s NATS-only
// `orders.create` pattern and tried to `consumer.subscribe()` a Kafka
// topic literally named "orders.create", which does not exist —
// `UNKNOWN_TOPIC_OR_PARTITION`, an unhandled rejection that crashed the
// whole process on every boot. `orders-create.controller.ts` gained the
// symmetric `Transport.NATS` binding for the same reason.
import { Controller, Inject, Optional } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { EventPattern, Payload, Transport } from '@nestjs/microservices';
import type { Envelope } from '@otc/contracts';
import { factCommandFor } from '../application/commands/saga-fact.commands';
import { BILLING_FACTS_TOPIC, FULFILLMENT_FACTS_TOPIC, ORDERS_FACTS_TOPIC } from '../infrastructure/outbox/kafka.config';

export class MalformedFactEnvelopeError extends Error {
  constructor(reason: string) {
    super(`saga-facts.controller: malformed fact envelope — ${reason}`);
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
 * Narrows an inbound Kafka message value to `Envelope`. In practice
 * `@nestjs/microservices`'s Kafka deserializer has already JSON-parsed a
 * `{...}`-shaped value by the time `@Payload()` hands it here, but a raw
 * `Buffer`/`string` (or a parse failure upstream) is handled too — a
 * malformed value has no trustworthy `eventId`/`correlationId`, so it can
 * be neither deduped nor parked (design.md §3.3): the caller's policy is
 * log-and-acknowledge, never a redelivery loop over a producer bug.
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

  const missing = REQUIRED_ENVELOPE_FIELDS.filter((field) => (candidate as Record<string, unknown>)[field] == null);
  if (missing.length > 0) {
    throw new MalformedFactEnvelopeError(`missing required field(s): ${missing.join(', ')}`);
  }

  return candidate as Envelope;
}

export interface SagaFactsControllerLogger {
  error(message: string, meta: Record<string, unknown>): void;
}

const CONSOLE_LOGGER: SagaFactsControllerLogger = {
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};

@Controller()
export class SagaFactsController {
  private readonly logger: SagaFactsControllerLogger;

  constructor(
    @Inject(CommandBus) private readonly commandBus: CommandBus,
    // `@Optional()` — see saga-command-sweeper.service.ts's constructor
    // comment: without it, Nest's container would try (and fail) to
    // resolve an interface-typed parameter with no registered provider.
    @Optional() logger: SagaFactsControllerLogger = CONSOLE_LOGGER,
  ) {
    this.logger = logger ?? CONSOLE_LOGGER;
  }

  @EventPattern(ORDERS_FACTS_TOPIC, Transport.KAFKA)
  async onOrdersFact(@Payload() payload: unknown): Promise<void> {
    await this.route(ORDERS_FACTS_TOPIC, payload);
  }

  @EventPattern(FULFILLMENT_FACTS_TOPIC, Transport.KAFKA)
  async onFulfillmentFact(@Payload() payload: unknown): Promise<void> {
    await this.route(FULFILLMENT_FACTS_TOPIC, payload);
  }

  @EventPattern(BILLING_FACTS_TOPIC, Transport.KAFKA)
  async onBillingFact(@Payload() payload: unknown): Promise<void> {
    await this.route(BILLING_FACTS_TOPIC, payload);
  }

  private async route(topic: string, payload: unknown): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = parseFactEnvelope(payload);
    } catch (error) {
      // Log-and-ack (design.md §3.3): a malformed value cannot be deduped
      // or parked, and redelivery cannot fix a producer bug. Returning
      // normally lets the offset commit.
      this.logger.error('saga-facts.controller: malformed fact envelope, acknowledged without processing', {
        topic,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const FactCommand = factCommandFor(envelope.eventType);
    if (!FactCommand) {
      // SO2 — the three self-produced facts (and anything else this
      // service does not consume on this topic): no CommandBus dispatch,
      // no transaction, no dedup row.
      return;
    }

    // Awaited — the fact `@CommandHandler` IS the transactional unit
    // (design.md §5.1); a rejection here propagates to
    // `@nestjs/microservices`'s no-offset-commit path unchanged (task E3).
    await this.commandBus.execute(new FactCommand(envelope));
  }
}
