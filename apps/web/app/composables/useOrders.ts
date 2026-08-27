import { computed, type Ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { PlaceOrderRequest, PlaceOrderResponse, OrderSummaryPage, OrderStatus } from '#shared/types/gateway';

export interface OrderListFilters {
  status?: OrderStatus[];
  retailerCode?: string;
  page: number;
  pageSize: number;
}

/** `GET /orders` (the read model, R54), through the server proxy. "Live updates" for this pass is TanStack Query's own polling refetch — the SSE push arrives with the order-detail page in a later pass. */
export function useOrdersQuery(filters: Ref<OrderListFilters>) {
  return useQuery({
    queryKey: computed(() => ['orders', filters.value]),
    queryFn: () =>
      $fetch<OrderSummaryPage>('/api/orders', {
        query: {
          status: filters.value.status?.length ? filters.value.status : undefined,
          retailerCode: filters.value.retailerCode || undefined,
          page: filters.value.page,
          pageSize: filters.value.pageSize,
        },
      }),
    refetchInterval: 4_000,
    placeholderData: (previous) => previous,
  });
}

export interface PlaceOrderPayload {
  request: PlaceOrderRequest;
  idempotencyKey: string;
}

/** `POST /orders` — 201 means accepted, not that the saga finished (openapi.yaml). Invalidates the order list so the new row shows up on the next poll. */
export function usePlaceOrderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: PlaceOrderPayload) =>
      $fetch<PlaceOrderResponse>('/api/orders', {
        method: 'POST',
        body: payload.request,
        headers: { 'Idempotency-Key': payload.idempotencyKey },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}
