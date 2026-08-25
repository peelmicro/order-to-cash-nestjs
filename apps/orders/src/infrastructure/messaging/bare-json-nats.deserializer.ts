// COPY OF — apps/fulfillment/src/infrastructure/messaging/bare-json-nats.deserializer.ts
// (also copied to apps/billing under the same name.)
//
// The wire finding (design.md §6.3, fulfillment_stock; also
// progress/review_gateway_rest_auth.md F1): `@nestjs/microservices`'s
// `ServerNats` treats a bare (id-less) JSON request as an EVENT (never
// replies) unless the deserialized message carries an `id`.
// `BareJsonNatsDeserializer` extends the framework's own
// `NatsRequestJSONDeserializer` and, after its normal `{ pattern, data }`
// mapping, assigns a SYNTHETIC id whenever the caller supplied a reply
// subject (`options.replyTo`, set by `ServerNats.handleMessage` from the raw
// NATS message's own `reply` field) — turning the message into a request
// Nest will actually answer. A message with no reply subject stays an
// event. The synthetic id exists only to route Nest's reply; no handler
// ever reads it.
//
// F1 (progress/review_gateway_rest_auth.md): `apps/orders/src/main.ts`
// installed neither this deserializer nor its serializer counterpart, so a
// bare-JSON caller (the Gateway's `NatsRpcClientAdapter`, and the saga's own
// `NatsSagaCommandsAdapter` shape) sent a request `orders.create` ran to
// completion on but never got a reply for — the order was placed and its
// outbox row written, and the caller timed out and retried, placing a
// second real order. Orders now installs this pair the same way
// Fulfillment and Billing already did.
//
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
