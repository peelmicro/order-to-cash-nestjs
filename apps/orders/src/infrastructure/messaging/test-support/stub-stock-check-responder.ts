// A TEST-ONLY stand-in for the Fulfillment responder of
// `fulfillment.stock.check` — feature 17 (`fulfillment_stock`) has not
// landed yet, so nothing in this repository answers that subject for real.
// This is the "stub responder inside the integration test harness" the
// `orders_acceptance` task explicitly calls for, rather than any
// always-yes shortcut inside the Orders service itself: production code
// NEVER imports this module (it lives under `test-support/`, and nothing
// under `src/{application,infrastructure/{persistence,outbox}}` or
// `presentation/` references it).
//
// Speaks the SAME wire shape `NatsStockAvailabilityAdapter` sends/expects —
// a bare JSON `StockCheckRequestPayload` in, a bare JSON
// `StockCheckReplyPayload` out — using the raw `nats` client directly, the
// same asymmetry (`@nestjs/microservices` for the INBOUND `orders.create`
// responder only) `nats-stock-availability.adapter.ts`'s header comment
// records.
import { JSONCodec, type NatsConnection, type Subscription } from 'nats';
import type { StockCheckReplyPayload, StockCheckRequestPayload } from '@otc/contracts';

const STOCK_CHECK_SUBJECT = 'fulfillment.stock.check';

export type StubStockCheckBehaviour = (request: StockCheckRequestPayload) => StockCheckReplyPayload;

export const alwaysAvailable: StubStockCheckBehaviour = (request) => ({
  available: true,
  lines: request.lines.map((line) => ({
    productCode: line.productCode,
    requested: line.quantity,
    available: line.quantity,
    sufficient: true,
  })),
});

export const alwaysUnavailable: StubStockCheckBehaviour = (request) => ({
  available: false,
  lines: request.lines.map((line) => ({
    productCode: line.productCode,
    requested: line.quantity,
    available: 0,
    sufficient: false,
  })),
});

export interface StubStockCheckResponder {
  stop(): Promise<void>;
}

/**
 * Starts a subscriber that answers every `fulfillment.stock.check` request
 * per `behaviour`. Runs on the SAME connection the caller passes in (a
 * separate connection from the caller under test is also fine — NATS core
 * request-reply does not care).
 *
 * `async` and `await`s a `connection.flush()` (a PING/PONG round trip)
 * before returning — otherwise a caller that sends its request immediately
 * after starting this responder can race ahead of the SUB frame reaching
 * the server, and NATS answers "no responders" instead of the intended
 * reply. `stop()` mirrors this with its own flush after `unsubscribe()`.
 */
export async function startStubStockCheckResponder(
  connection: NatsConnection,
  behaviour: StubStockCheckBehaviour = alwaysAvailable,
): Promise<StubStockCheckResponder> {
  const requestCodec = JSONCodec<StockCheckRequestPayload>();
  const replyCodec = JSONCodec<StockCheckReplyPayload>();
  const subscription: Subscription = connection.subscribe(STOCK_CHECK_SUBJECT);

  void (async () => {
    for await (const message of subscription) {
      if (!message.reply) {
        continue;
      }
      const request = requestCodec.decode(message.data);
      message.respond(replyCodec.encode(behaviour(request)));
    }
  })();

  await connection.flush();

  return {
    async stop(): Promise<void> {
      subscription.unsubscribe();
      await connection.flush();
    },
  };
}
