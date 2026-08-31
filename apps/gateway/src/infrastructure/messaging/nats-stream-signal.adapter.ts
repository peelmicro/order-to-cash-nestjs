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
import { JSONCodec, type Msg, type NatsConnection, type Subscription } from 'nats';
import type { StreamHub } from '../../application/stream-hub';
import { activeTraceId } from '../observability/trace-context';

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
        //
        // B5 closeout (progress/review_final_checkpoint.md) — CLAUDE.md §
        // Logging ("structured JSON with correlationId on every line")
        // applies to this line too, even though it is arguably outside
        // R58's three named categories. `message.data` failed to decode,
        // but NATS headers are a SEPARATE channel from the payload
        // (`nats-update-signal.publisher.ts` sets `x-correlation-id` via
        // `natsHeaders()` before encoding the body), so they survive a
        // payload decode failure and are read here without touching
        // `message.data` again. `traceId` follows the same
        // "omit rather than log the literal string undefined" rule every
        // other R58 site in this service uses (`activeTraceId()`) — it
        // reads whatever span is genuinely active, exactly like every
        // other call site, and is `undefined` at THIS service's actual
        // production call site (`main.ts` starts this adapter at boot,
        // outside any request span — there is no auto-instrumentation for
        // a plain core-NATS subscribe loop, unlike the inbound-HTTP case
        // `problem-json.filter.ts` relies on), so this stays the honest,
        // not-fabricated value for that key on the path this service
        // actually runs (proven both ways in
        // `nats-stream-signal-log-trace-id.spec.ts`).
        this.logDecodeFailure(message, error);
      }
    }
  }

  private logDecodeFailure(message: Msg, error: unknown): void {
    const correlationId = message.headers?.get('x-correlation-id');
    const traceId = activeTraceId();
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'gateway: nats-stream-signal — failed to decode a signal frame',
        subject: message.subject,
        ...(correlationId ? { correlationId } : {}),
        ...(traceId ? { traceId } : {}),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  async stop(): Promise<void> {
    this.orderUpdatedSub?.unsubscribe();
    this.timelineAppendedSub?.unsubscribe();
  }
}
