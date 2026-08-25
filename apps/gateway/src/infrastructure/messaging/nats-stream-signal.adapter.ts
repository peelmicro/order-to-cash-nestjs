// Subscribes to the projector's read-model update signal
// (apps/projector/src/infrastructure/signal/nats-update-signal.publisher.ts
// — `readmodel.order.updated.<orderId>` and
// `readmodel.timeline.appended.<orderId>`, wildcarded on the last token so
// ONE subscription per subject covers every order) and feeds every decoded
// frame into the `StreamHub` (application/stream-hub.ts). Fire-and-forget,
// subscribe-only — this service answers no fact and publishes nothing on
// NATS itself, matching Group D's brief ("the NATS subjects the SSE stream
// consumes"). NOT a `@MessagePattern` responder: this is a plain core NATS
// subscription over the SAME outbound connection the RPC client uses,
// started once at boot (`app.module.ts`), exactly the shape
// `apps/projector`'s OWN outbound connection uses for the opposite
// direction (publish only, never subscribe).
import { JSONCodec, type NatsConnection, type Subscription } from 'nats';
import type { StreamHub } from '../../application/stream-hub';

export const ORDER_UPDATED_WILDCARD_SUBJECT = 'readmodel.order.updated.*';
export const TIMELINE_APPENDED_WILDCARD_SUBJECT = 'readmodel.timeline.appended.*';

export class NatsStreamSignalAdapter {
  private orderUpdatedSub: Subscription | undefined;
  private timelineAppendedSub: Subscription | undefined;

  constructor(
    private readonly connection: NatsConnection,
    private readonly hub: StreamHub,
  ) {}

  start(): void {
    const orderUpdateCodec = JSONCodec<{ orderId: string } & Record<string, unknown>>();
    const timelineEntryCodec = JSONCodec<{ orderId: string } & Record<string, unknown>>();

    this.orderUpdatedSub = this.connection.subscribe(ORDER_UPDATED_WILDCARD_SUBJECT);
    this.timelineAppendedSub = this.connection.subscribe(TIMELINE_APPENDED_WILDCARD_SUBJECT);

    void this.consume(this.orderUpdatedSub, (data) => {
      const decoded = orderUpdateCodec.decode(data);
      this.hub.publish('order.updated', decoded.orderId, decoded);
    });
    void this.consume(this.timelineAppendedSub, (data) => {
      const decoded = timelineEntryCodec.decode(data);
      this.hub.publish('timeline.appended', decoded.orderId, decoded);
    });
  }

  private async consume(subscription: Subscription, onMessage: (data: Uint8Array) => void): Promise<void> {
    for await (const message of subscription) {
      try {
        onMessage(message.data);
      } catch (error) {
        // Malformed signal frame — log-and-continue, never bring the
        // subscription down: a bad frame is a notification-channel problem,
        // not a read-model-correctness one (the read model itself is
        // written by the projector alone, unaffected by anything here).
        console.error('[gateway] nats-stream-signal: failed to decode a signal frame', error);
      }
    }
  }

  async stop(): Promise<void> {
    this.orderUpdatedSub?.unsubscribe();
    this.timelineAppendedSub?.unsubscribe();
  }
}
