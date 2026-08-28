import { computed, type Ref } from 'vue';
import { useQuery, type QueryClient } from '@tanstack/vue-query';
import type { OrderDetail, OrderStreamUpdate, ProjectionPending, TimelineStreamEntry } from '#shared/types/gateway';

export type OrderDetailResult =
  | { kind: 'pending'; pending: ProjectionPending }
  | { kind: 'ready'; detail: OrderDetail };

export function orderDetailQueryKey(orderId: string): unknown[] {
  return ['order-detail', orderId];
}

/**
 * `GET /orders/{id}` through the server proxy, read via `$fetch.raw` rather
 * than plain `$fetch` specifically so the real HTTP status is visible —
 * `202`/`ProjectionPending` (R55) is a genuine success as far as `ofetch` is
 * concerned, so distinguishing "loaded" from "accepted, not projected yet"
 * has to come from the status code the server route forwarded, not from a
 * thrown error.
 */
async function fetchOrderDetail(orderId: string): Promise<OrderDetailResult> {
  const response = await $fetch.raw<OrderDetail | ProjectionPending>(`/api/orders/${orderId}`);
  if (response.status === 202) {
    return { kind: 'pending', pending: response._data as ProjectionPending };
  }
  return { kind: 'ready', detail: response._data as OrderDetail };
}

/**
 * `GET /orders/{id}` (R54). While the answer is `202`/projection-pending
 * (R55), polls at the interval the Gateway itself suggests (`retryAfterMs`)
 * rather than a tight loop or a fixed guess — and stops polling entirely
 * once a real document has landed, since the live SSE stream takes over
 * from there.
 */
export function useOrderDetailQuery(orderId: Ref<string>) {
  return useQuery({
    queryKey: computed(() => orderDetailQueryKey(orderId.value)),
    queryFn: () => fetchOrderDetail(orderId.value),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.kind === 'pending' ? (data.pending.retryAfterMs ?? 2000) : false;
    },
  });
}

/**
 * Patches the cached `OrderDetail`'s header fields from a live
 * `order.updated` stream frame. A no-op while no `ready` document is
 * cached yet (nothing to patch) — the initial `GET` and the `202` polling
 * path own that transition, this only ever updates an already-loaded
 * document.
 */
export function applyOrderStreamUpdate(queryClient: QueryClient, orderId: string, update: OrderStreamUpdate): void {
  queryClient.setQueryData<OrderDetailResult>(orderDetailQueryKey(orderId), (current) => {
    if (!current || current.kind !== 'ready') return current;
    return {
      kind: 'ready',
      detail: {
        ...current.detail,
        status: update.status,
        cancellationReason: update.cancellationReason ?? current.detail.cancellationReason,
        references: update.references ?? current.detail.references,
        totals: update.totals ?? current.detail.totals,
        updatedAt: update.occurredAt,
      },
    };
  });
}

/**
 * Appends a live `timeline.appended` frame to the cached `OrderDetail`'s
 * `events`, re-sorted by `occurredAt` (R50) — the same ordering discipline
 * the projector's own read model already applies server-side.
 *
 * **R51 dedup lives here, not only in the stream transport.** Even if a
 * caller somehow invoked this twice for the same `eventId` (a redelivered
 * frame the transport-level dedup missed, or a frame that arrived both via
 * a fresh `GET` and the stream), the reducer itself refuses to append a
 * second entry — the guarantee holds regardless of which layer a bug might
 * appear in.
 */
export function applyTimelineAppended(queryClient: QueryClient, orderId: string, entry: TimelineStreamEntry): void {
  queryClient.setQueryData<OrderDetailResult>(orderDetailQueryKey(orderId), (current) => {
    if (!current || current.kind !== 'ready') return current;
    if (current.detail.events.some((existing) => existing.eventId === entry.eventId)) {
      return current;
    }
    const events = [
      ...current.detail.events,
      { eventId: entry.eventId, eventType: entry.eventType, occurredAt: entry.occurredAt, summary: entry.summary },
    ].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    return { kind: 'ready', detail: { ...current.detail, events } };
  });
}
