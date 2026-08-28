import { onScopeDispose, ref, type Ref } from 'vue';
import { OrderStreamClient, type EventSourceFactory, type EventSourceLike, type StreamConnectionStatus } from '@/lib/order-stream-client';
import type { OrderStreamUpdate, TimelineStreamEntry } from '#shared/types/gateway';

export interface UseOrderStreamHandlers {
  onOrderUpdated: (update: OrderStreamUpdate) => void;
  onTimelineAppended: (entry: TimelineStreamEntry) => void;
  onResync: () => void;
}

/** The real browser `EventSource`, connecting to this Nuxt origin's own `/api/orders/stream` proxy — never the Gateway directly (F14). Only ever invoked client-side (`connect()` is called from the page's `onMounted`, which never runs during SSR), so `EventSource` existing is never in question at the call site. */
const browserEventSourceFactory: EventSourceFactory = (url) => new EventSource(url) as unknown as EventSourceLike;

/**
 * The Vue-reactive wrapper around `OrderStreamClient` — owns nothing the
 * class doesn't already own; it only turns `onStatusChange` into a `Ref`
 * template code can bind to, and disconnects automatically when the owning
 * component's scope is disposed.
 */
export function useOrderStream(orderId: Ref<string>, handlers: UseOrderStreamHandlers, factory: EventSourceFactory = browserEventSourceFactory) {
  const status = ref<StreamConnectionStatus>('connecting');
  let client: OrderStreamClient | null = null;

  function connect(seedEventIds: Iterable<string> = []): void {
    client = new OrderStreamClient(
      `/api/orders/stream?orderId=${encodeURIComponent(orderId.value)}`,
      {
        onOrderUpdated: handlers.onOrderUpdated,
        onTimelineAppended: handlers.onTimelineAppended,
        onResync: handlers.onResync,
        onStatusChange: (next) => {
          status.value = next;
        },
      },
      factory,
    );
    client.seedSeenEventIds(seedEventIds);
    client.connect();
  }

  function disconnect(): void {
    client?.disconnect();
    client = null;
  }

  onScopeDispose(disconnect);

  return { status, connect, disconnect };
}
