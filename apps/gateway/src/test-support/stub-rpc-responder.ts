// TEST-ONLY stand-ins for the RPC responders Orders/Fulfillment/Billing own
// — none of those services run in this suite; this integration harness
// tests the GATEWAY's own translation, not their behaviour. Same shape
// apps/orders/src/infrastructure/messaging/test-support/stub-stock-check-responder.ts
// establishes: raw `nats` client, bare JSON, production code never imports
// this module (it lives under `test-support/`).
import { JSONCodec, type NatsConnection, type Subscription } from 'nats';

export interface StubResponder {
  stop(): Promise<void>;
}

/**
 * Starts a subscriber on `subject` that answers every request with
 * `behaviour(request)`. `await connection.flush()` before returning (and
 * again on `stop()`) — a PING/PONG round trip that prevents the caller
 * racing ahead of the SUB frame reaching the server.
 */
export async function startStubResponder<TRequest, TReply>(
  connection: NatsConnection,
  subject: string,
  behaviour: (request: TRequest) => TReply,
): Promise<StubResponder> {
  const requestCodec = JSONCodec<TRequest>();
  const replyCodec = JSONCodec<TReply>();
  const subscription: Subscription = connection.subscribe(subject);

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
