// PR17 — two `publish` calls per applied fact, on
// `readmodel.order.updated.<orderId>` and
// `readmodel.timeline.appended.<orderId>`, built from the POST-APPLY
// document (design.md §7.2). Core NATS publish — fire-and-forget, no reply
// subject, no responder, nothing awaited beyond the publish itself. `x-correlation-id`
// travels in NATS headers, same as the RPC adapters
// (apps/orders/src/infrastructure/messaging/nats-saga-commands.adapter.ts).
import { headers as natsHeaders, JSONCodec, type NatsConnection } from 'nats';
import type { AppliedOrderTimeline } from '../../application/ports/read-model-writer.port';
import type { UpdateSignalPublisher } from '../../application/ports/update-signal.port';

export function orderUpdatedSubject(orderId: string): string {
  return `readmodel.order.updated.${orderId}`;
}

export function timelineAppendedSubject(orderId: string): string {
  return `readmodel.timeline.appended.${orderId}`;
}

interface OrderStreamUpdate {
  eventId: string;
  orderId: string;
  orderReference: string | null;
  status: string;
  cancellationReason: string | null;
  references: AppliedOrderTimeline['references'];
  totals: AppliedOrderTimeline['totals'];
  occurredAt: string;
}

interface TimelineStreamEntry {
  eventId: string;
  orderId: string;
  orderReference: string | null;
  eventType: string;
  occurredAt: string;
  summary: string;
}

export class NatsUpdateSignalPublisher implements UpdateSignalPublisher {
  private readonly orderUpdateCodec = JSONCodec<OrderStreamUpdate>();
  private readonly timelineEntryCodec = JSONCodec<TimelineStreamEntry>();

  constructor(private readonly connection: NatsConnection) {}

  async publish(document: AppliedOrderTimeline): Promise<void> {
    const h = natsHeaders();
    h.set('x-correlation-id', document.orderId);

    const orderUpdate: OrderStreamUpdate = {
      eventId: document.latestEntry.eventId,
      orderId: document.orderId,
      orderReference: document.orderReference,
      status: document.status,
      cancellationReason: document.cancellationReason,
      references: document.references,
      totals: document.totals,
      occurredAt: document.latestEntry.occurredAt,
    };
    const timelineEntry: TimelineStreamEntry = {
      eventId: document.latestEntry.eventId,
      orderId: document.orderId,
      orderReference: document.orderReference,
      eventType: document.latestEntry.eventType,
      occurredAt: document.latestEntry.occurredAt,
      summary: document.latestEntry.summary,
    };

    // Two independent, fire-and-forget publishes — neither awaits a
    // response, and a failure on either propagates to the caller (whose
    // job, per PR19, is to log-and-swallow it — never here).
    this.connection.publish(orderUpdatedSubject(document.orderId), this.orderUpdateCodec.encode(orderUpdate), { headers: h });
    this.connection.publish(timelineAppendedSubject(document.orderId), this.timelineEntryCodec.encode(timelineEntry), { headers: h });
  }
}
