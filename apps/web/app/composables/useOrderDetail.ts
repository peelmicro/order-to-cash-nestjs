import { computed, watch, type Ref } from 'vue';
import { useQuery, type QueryClient } from '@tanstack/vue-query';
import type { OrderDetail, OrderStatus, OrderStreamUpdate, ProjectionPending, TimelineStreamEntry } from '#shared/types/gateway';

export type OrderDetailResult =
  | { kind: 'pending'; pending: ProjectionPending }
  | { kind: 'ready'; detail: OrderDetail };

export function orderDetailQueryKey(orderId: string): unknown[] {
  return ['order-detail', orderId];
}

/**
 * D8: `completed`/`cancelled` are the only two statuses from which an order
 * can never change again — NOT, as an earlier version of this comment
 * claimed, "the only two statuses the saga does not leave on its own".
 * `invoiced` is also a status the saga rests at on its own (it waits for a
 * human or n8n to register a payment) — but the document CAN still change
 * from `invoiced`, which is exactly why `useOrderDetailQuery` keeps polling
 * it. The accurate rule (CLAUDE.md's "never poll a state the correct saga
 * leaves within a poll interval", mirrored): keep polling until the document
 * can no longer change at all, terminal or not.
 */
const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['completed', 'cancelled']);

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.has(status);
}

/**
 * D2 — the stale-page window's actual fix. Deliberately slow, and
 * deliberately a *backstop* rather than the primary update path (the SSE
 * stream stays that): the only way to guarantee convergence on "a stream
 * frame was lost entirely" — no resend, no resumed:false, no gap the client
 * can detect from the stream alone — is a source of truth the page consults
 * again on its own, independent of whether the stream ever tells it to.
 * `onResync` (stream.ready's `resumed:false` handler, `[id].vue`) already
 * closes the common case fast; this closes it unconditionally, at the cost
 * of one extra `GET` every few seconds while an order is still live.
 */
export const STALE_STATUS_BACKSTOP_MS = 5000;

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
 * rather than a tight loop or a fixed guess.
 *
 * Once a real document has landed, the live SSE stream is the *primary*
 * updater — but polling does not stop outright. **D2**: the page used to
 * stop polling entirely the moment a `ready` document landed, relying on
 * the stream alone from then on; a single fact projected in the window
 * between this GET resolving and the page's `connect()` call (or, more
 * generally, any single frame the stream loses entirely, for any reason,
 * with no signal to the client that it did) left the page showing a stale
 * status forever, with the connection indicator reading `Live` the whole
 * time — it had no way to tell it was wrong. So instead: while the order is
 * NOT yet in a terminal status (`completed`/`cancelled` — D8: the only two
 * statuses from which the document can no longer change, not merely the
 * only two the saga rests at on its own), keep refetching, slowly
 * (`STALE_STATUS_BACKSTOP_MS`) — a deliberate backstop, not a fast poll,
 * that guarantees convergence on the truth within one interval regardless
 * of what the stream did or didn't deliver.
 *
 * **D7, the backstop's own residual hole.** Stopping dead the instant the
 * cached status first reads terminal guards the *status* but not the
 * *timeline*: if the status turns terminal live (an `order.updated` frame,
 * or this very backstop's own GET) while a sibling fact of the same burst
 * (e.g. `credit.released.v1`, sharing `occurredAt` with `order.completed.v1`
 * to the millisecond) has not yet been separately projected or its own
 * `timeline.appended` frame has been lost, polling stopping immediately
 * leaves that entry out forever, permanently, with the badge reading
 * correctly the whole time. A *single* refetch fired the instant the
 * transition is observed does not close this: it would race the very same
 * in-flight projection that produced the terminal status in the first
 * place. So instead: once a transition into terminal is OBSERVED BY THIS
 * CLIENT (as opposed to a document that was already terminal on its very
 * first successful GET — nothing was live-transitioning then, so there is
 * no burst to suspect), keep the backstop alive for exactly one further
 * `STALE_STATUS_BACKSTOP_MS` interval, giving the projector time to settle,
 * then stop for good. `observedNonTerminal`/`extraPollDone` below are local
 * to this composable's own closure, reset per `orderId` (the `watch` below)
 * so navigating between two order-detail pages without a full remount does
 * not leak one order's polling history into another's.
 */
export function useOrderDetailQuery(orderId: Ref<string>) {
  let observedNonTerminal = false;
  let extraPollDone = false;
  watch(orderId, () => {
    observedNonTerminal = false;
    extraPollDone = false;
  });

  return useQuery({
    queryKey: computed(() => orderDetailQueryKey(orderId.value)),
    queryFn: () => fetchOrderDetail(orderId.value),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.kind === 'pending') return data.pending.retryAfterMs ?? 2000;
      if (data?.kind !== 'ready') return false;
      if (!isTerminalOrderStatus(data.detail.status)) {
        observedNonTerminal = true;
        return STALE_STATUS_BACKSTOP_MS;
      }
      // D7: terminal now. Only schedule the one-shot catch-up poll if this
      // client actually watched the transition happen (never for a document
      // that read terminal on its very first GET — see the doc comment
      // above) and only once, ever, per order.
      if (observedNonTerminal && !extraPollDone) {
        extraPollDone = true;
        return STALE_STATUS_BACKSTOP_MS;
      }
      return false;
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
 *
 * `causationId` (amendment A1) is carried through onto the appended entry
 * verbatim, so a live-arriving entry's causal-link rendering in `[id].vue`
 * behaves identically to one that arrived via the initial `GET` — the same
 * `TimelineEntry`-shaped object either way, resolved the same way.
 */
export function applyTimelineAppended(queryClient: QueryClient, orderId: string, entry: TimelineStreamEntry): void {
  queryClient.setQueryData<OrderDetailResult>(orderDetailQueryKey(orderId), (current) => {
    if (!current || current.kind !== 'ready') return current;
    if (current.detail.events.some((existing) => existing.eventId === entry.eventId)) {
      return current;
    }
    const events = [
      ...current.detail.events,
      { eventId: entry.eventId, causationId: entry.causationId, eventType: entry.eventType, occurredAt: entry.occurredAt, summary: entry.summary },
    ].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    return { kind: 'ready', detail: { ...current.detail, events } };
  });
}
