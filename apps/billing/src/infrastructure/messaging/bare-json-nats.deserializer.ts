// COPY OF — apps/fulfillment/src/infrastructure/messaging/bare-json-nats.deserializer.ts
// The wire finding (fulfillment_stock design.md §6.3): `@nestjs/microservices`'s `ServerNats`
// treats a bare (id-less) JSON request as an EVENT (never replies) unless
// the deserialized message carries an `id`. `BareJsonNatsDeserializer`
// extends the framework's own `NatsRequestJSONDeserializer` and, after its
// normal `{ pattern, data }` mapping, assigns a SYNTHETIC id whenever the
// caller supplied a reply subject (`options.replyTo`, set by
// `ServerNats.handleMessage` from the raw NATS message's own `reply`
// field) — turning the message into a request Nest will actually answer.
// A message with no reply subject stays an event. The synthetic id exists
// only to route Nest's reply; no handler ever reads it (idempotency here is
// `orderReference`-scoped, design.md §4.5).
// Decorator metadata (`@Optional()` et al., used deep inside
// `@nestjs/microservices`'s own console logger) needs `Reflect.getMetadata`
// registered before that module's code runs — the same
// `orders-create.dto.ts` self-containment reasoning: a spec file that
// imports this module in isolation (no `main.ts` in its module graph)
// would otherwise fail the same way.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
// A deep import: the base class is not re-exported from the package's
// public barrel, but IS part of its resolvable module surface (no
// `exports` map restricts it) — verified against the installed
// @nestjs/microservices@11.2.1 (design.md §6.3).
import { NatsRequestJSONDeserializer } from '@nestjs/microservices/deserializers/nats-request-json.deserializer';
import type { IncomingEvent, IncomingRequest } from '@nestjs/microservices';

function hasId(message: IncomingRequest | IncomingEvent): message is IncomingRequest {
  return (message as Partial<IncomingRequest>).id !== undefined;
}

export class BareJsonNatsDeserializer extends NatsRequestJSONDeserializer {
  override deserialize(value: Uint8Array, options?: Record<string, unknown>): IncomingRequest | IncomingEvent {
    const message = super.deserialize(value, options);
    if (!hasId(message) && options?.replyTo) {
      const withSyntheticId: IncomingRequest = { ...message, id: randomUUID() };
      return withSyntheticId;
    }
    return message;
  }
}
