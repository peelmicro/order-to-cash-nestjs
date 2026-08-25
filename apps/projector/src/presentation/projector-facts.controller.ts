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
import { Controller, Inject, Optional } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { EventPattern, Payload, Transport } from '@nestjs/microservices';
import type { Envelope } from '@otc/contracts';
import { UnknownFactTypeError } from '../domain/fact-projection';
import { ProjectFactCommand } from '../application/commands/project-fact.command';
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

const CONSOLE_LOGGER: ProjectorFactsControllerLogger = {
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};

@Controller()
export class ProjectorFactsController {
  private readonly logger: ProjectorFactsControllerLogger;

  constructor(
    @Inject(CommandBus) private readonly commandBus: CommandBus,
    // @Optional() — without it, Nest's container tries (and fails) to
    // resolve an interface-typed parameter with no registered provider
    // (same reasoning as notification-facts.controller.ts's constructor).
    @Optional() logger: ProjectorFactsControllerLogger = CONSOLE_LOGGER,
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
      // PR3 — log-and-ack: a malformed value cannot be projected, and
      // redelivery cannot fix a producer bug.
      this.logger.error(
        'projector-facts.controller: malformed fact envelope, acknowledged without processing',
        { topic, error: error instanceof Error ? error.message : String(error) },
      );
      return;
    }

    try {
      await this.commandBus.execute(new ProjectFactCommand(envelope));
    } catch (error) {
      if (error instanceof UnknownFactTypeError) {
        // PR4 — log-and-ack, NOT a silent discard: an unknown eventType is
        // visible in the logs, but is never repairable by redelivery.
        this.logger.error(
          'projector-facts.controller: unknown eventType, acknowledged without processing',
          { topic, eventType: envelope.eventType, eventId: envelope.eventId },
        );
        return;
      }
      // Every other failure (a Mongo write failure, for instance) rethrows
      // so Kafka redelivers the fact (PR6's own note: idempotency is a
      // property of the query, so redelivery is always safe to retry).
      throw error;
    }
  }
}
