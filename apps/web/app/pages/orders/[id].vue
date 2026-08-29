<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { applyOrderStreamUpdate, applyTimelineAppended, useOrderDetailQuery } from '@/composables/useOrderDetail';
import { useOrderStream } from '@/composables/useOrderStream';
import { formatMoney } from '@/lib/money';
import type { EventSourceFactory } from '@/lib/order-stream-client';
import { describeFetchError } from '@/lib/problem';
import type { OrderStatus, TimelineEntry } from '#shared/types/gateway';

definePageMeta({ layout: 'default' });

// `streamFactory`/`orderId` are test-only seams — never passed by real
// navigation (Nuxt page components take no props from routing). `streamFactory`
// lets a component test feed real SSE-shaped frames through a controllable
// transport instead of a real network connection happy-dom cannot make; left
// undefined in production, `useOrderStream` falls back to the real
// `window.EventSource`. `orderId` exists only because `@nuxt/test-utils`'s
// `renderSuspended(Component, { route })` moves the router to the given path
// but does not run this app's real file-based route matching, so
// `useRoute().params.id` is never populated when the page is rendered
// directly in a component test (confirmed directly: a route-param probe
// component rendered the same way saw `route.params` as `{}`) — real
// navigation via `<NuxtLink>`/`navigateTo` always goes through the real
// router, where the dynamic segment IS populated, so this prop is simply
// never supplied outside a test.
const props = defineProps<{ streamFactory?: EventSourceFactory; orderId?: string }>();

const route = useRoute();
const orderId = computed(() => props.orderId ?? String(route.params.id));

const queryClient = useQueryClient();
const { data, isLoading, isError, error, refetch } = useOrderDetailQuery(orderId);

const streamStarted = ref(false);

const { status: connectionStatus, connect, disconnect } = useOrderStream(
  orderId,
  {
    onOrderUpdated: (update) => applyOrderStreamUpdate(queryClient, orderId.value, update),
    onTimelineAppended: (entry) => applyTimelineAppended(queryClient, orderId.value, entry),
    // openapi.yaml's own honesty principle (§ "Reconnection"): `resumed: false`
    // means the replay buffer aged out — the stream is a notification
    // channel, not the source of truth, so the only correct move is to
    // re-fetch and resynchronise rather than silently keep possibly-stale
    // data on screen.
    onResync: () => {
      refetch();
    },
  },
  props.streamFactory,
);

// Connect once the initial load has actually landed a real document — never
// while `202`/projection-pending (R55): there is nothing to usefully
// subscribe to yet, and the query's own `retryAfterMs` polling already
// covers that wait.
watch(
  () => data.value,
  (current) => {
    if (current?.kind === 'ready' && !streamStarted.value) {
      streamStarted.value = true;
      connect(current.detail.events.map((event) => event.eventId));
    }
  },
  { immediate: true },
);

onUnmounted(() => disconnect());

function statusVariant(status: OrderStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'cancelled') return 'destructive';
  if (status === 'completed' || status === 'paid') return 'secondary';
  return 'outline';
}

function connectionLabel(state: string): string {
  if (state === 'connected') return 'Live';
  if (state === 'connecting') return 'Connecting…';
  if (state === 'reconnecting') return 'Reconnecting…';
  return 'Connection lost';
}

function connectionVariant(state: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (state === 'connected') return 'secondary';
  if (state === 'gave-up') return 'destructive';
  return 'outline';
}

function retryConnection(): void {
  const current = data.value;
  connect(current?.kind === 'ready' ? current.detail.events.map((event) => event.eventId) : []);
}

/**
 * Resolves a timeline entry's `causationId` (amendment A1) to the entry it
 * names, within THIS order's own `events[]` only. Two ways this can come
 * back empty, both intentional and both required to render nothing at all,
 * never a broken link or a placeholder:
 *
 * - The entry has no `causationId` at all — every entry projected before A1
 *   landed (e.g. `ORD-000030` in the running seed data). Absence is normal.
 * - The entry HAS a `causationId`, but it does not match any `eventId` in
 *   this array — it names a *command* `requestId` instead of a fact
 *   `eventId` (the pre-A1-Billing sibling case the brief names explicitly,
 *   `payment.received.v1`/`credit.released.v1`). An unresolved id must
 *   never surface as a dangling reference.
 */
function causingEvent(entry: TimelineEntry, events: TimelineEntry[]): TimelineEntry | undefined {
  if (!entry.causationId) return undefined;
  return events.find((candidate) => candidate.eventId === entry.causationId);
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-semibold">
        Order detail
      </h1>
      <NuxtLink to="/orders" class="text-sm text-muted-foreground hover:underline">
        Back to orders
      </NuxtLink>
    </div>

    <p v-if="isError" class="text-sm text-destructive" data-testid="order-detail-error">
      Could not load this order: {{ describeFetchError(error, 'the request failed') }}
    </p>

    <div v-else-if="isLoading" class="text-sm text-muted-foreground" data-testid="order-detail-loading">
      Loading…
    </div>

    <!-- R55's honest "projection pending" state — not a spinner pretending
         to load, not a 404. The query keeps polling in the background at
         the Gateway's own suggested interval. -->
    <div
      v-else-if="data?.kind === 'pending'"
      class="rounded-md border border-dashed p-6 text-sm text-muted-foreground"
      data-testid="order-detail-pending"
    >
      <p class="font-medium text-foreground">
        Waiting for this order to appear
      </p>
      <p>{{ data.pending.message ?? 'The order was accepted and is not projected yet. Subscribe to /orders/stream or retry.' }}</p>
    </div>

    <div v-else-if="data?.kind === 'ready'" class="flex flex-col gap-6">
      <Card>
        <CardHeader class="flex flex-row items-center justify-between">
          <div>
            <CardTitle>{{ data.detail.orderReference ?? data.detail.orderId }}</CardTitle>
            <p class="text-sm text-muted-foreground">
              {{ data.detail.retailer?.name ?? data.detail.retailer?.code }} · {{ data.detail.company?.name ?? data.detail.company?.code }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <Badge :variant="statusVariant(data.detail.status)" data-testid="order-detail-status">
              {{ data.detail.status }}
            </Badge>
            <Badge
              :variant="connectionVariant(connectionStatus)"
              data-testid="stream-status"
              :data-status="connectionStatus"
            >
              {{ connectionLabel(connectionStatus) }}
            </Badge>
            <Button v-if="connectionStatus === 'gave-up'" size="sm" variant="outline" data-testid="stream-retry" @click="retryConnection">
              Retry connection
            </Button>
          </div>
        </CardHeader>
        <CardContent class="flex flex-col gap-2">
          <div v-if="!data.detail.headerComplete" class="text-xs text-muted-foreground" data-testid="order-detail-header-incomplete">
            Header still filling in — the timeline is real, some fields are not projected yet.
          </div>
          <div class="flex flex-wrap gap-6 text-sm">
            <div>
              <span class="text-muted-foreground">Total</span>
              <p class="font-medium">
                {{ data.detail.totals && data.detail.currency ? formatMoney(data.detail.totals.totalAmount, data.detail.currency) : '—' }}
              </p>
            </div>
            <div v-if="data.detail.cancellationReason">
              <span class="text-muted-foreground">Cancellation reason</span>
              <p class="font-medium">
                {{ data.detail.cancellationReason }}
              </p>
            </div>
            <div v-if="data.detail.references?.despatchReference">
              <span class="text-muted-foreground">Despatch</span>
              <p class="font-medium">
                {{ data.detail.references.despatchReference }}
              </p>
            </div>
            <div v-if="data.detail.references?.invoiceReference">
              <span class="text-muted-foreground">Invoice</span>
              <p class="font-medium">
                {{ data.detail.references.invoiceReference }}
              </p>
            </div>
            <div v-if="data.detail.references?.paymentReference">
              <span class="text-muted-foreground">Payment</span>
              <p class="font-medium">
                {{ data.detail.references.paymentReference }}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold text-muted-foreground">
          Timeline
        </h2>
        <ol class="flex flex-col gap-2" data-testid="order-timeline">
          <li
            v-for="event in data.detail.events"
            :id="`timeline-entry-${event.eventId}`"
            :key="event.eventId"
            data-testid="timeline-entry"
            :data-event-id="event.eventId"
            class="flex items-start justify-between gap-4 rounded-md border p-3 text-sm target:bg-muted transition-colors"
          >
            <div>
              <p class="font-medium">
                {{ event.summary }}
              </p>
              <p class="text-xs text-muted-foreground">
                {{ event.eventType }}
              </p>
              <!-- Amendment A1's causal edge (§ design constraint 1-2 of this
                   pass): only rendered when `causationId` resolves to a fact
                   genuinely present in this order's own timeline. Absent
                   `causationId` (pre-A1 orders) and an unresolvable
                   `causationId` (points at a command requestId, not a fact
                   eventId) both fall through to rendering nothing here. -->
              <p
                v-if="causingEvent(event, data.detail.events)"
                class="text-xs text-muted-foreground"
                data-testid="timeline-causation"
              >
                caused by
                <a
                  :href="`#timeline-entry-${causingEvent(event, data.detail.events)!.eventId}`"
                  class="underline decoration-dotted underline-offset-2 hover:text-foreground"
                  data-testid="timeline-causation-link"
                >{{ causingEvent(event, data.detail.events)!.eventType }}</a>
              </p>
            </div>
            <span class="whitespace-nowrap text-xs text-muted-foreground">{{ new Date(event.occurredAt).toLocaleString() }}</span>
          </li>
        </ol>
        <p v-if="!data.detail.events.length" class="text-sm text-muted-foreground">
          No facts recorded yet.
        </p>
      </div>
    </div>
  </div>
</template>
