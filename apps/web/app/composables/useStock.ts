import { computed, type Ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { ReplenishStockRequest, ReplenishStockResponse, StockPage } from '#shared/types/gateway';

export interface StockListFilters {
  companyCode?: string;
  productCode?: string;
  belowThreshold?: boolean;
  page: number;
  pageSize: number;
}

/**
 * `GET /stock` — a live read of Fulfillment's write model (openapi.yaml:
 * "stock is not part of an order's timeline"), through the server proxy.
 * Polling refetch, same convention as `useOrdersQuery`/`useInvoicesQuery` —
 * there is no stock stream in the spec, and this feature's own brief is
 * explicit that adding one is out of scope.
 */
export function useStockQuery(filters: Ref<StockListFilters>) {
  return useQuery({
    queryKey: computed(() => ['stock', filters.value]),
    queryFn: () =>
      $fetch<StockPage>('/api/stock', {
        query: {
          companyCode: filters.value.companyCode || undefined,
          productCode: filters.value.productCode || undefined,
          belowThreshold: filters.value.belowThreshold || undefined,
          page: filters.value.page,
          pageSize: filters.value.pageSize,
        },
      }),
    refetchInterval: 4_000,
    placeholderData: (previous) => previous,
  });
}

export interface ReplenishPayload {
  companyCode: string;
  productCode: string;
  /** A DELTA to add to on-hand units — never a target level (openapi.yaml). */
  units: number;
}

/**
 * `POST /stock/replenish` — emits no fact (a top-up is outside any saga),
 * so this mutation only invalidates the stock list so the next poll (or an
 * immediate refetch) shows the new on-hand figure; there is nothing to
 * subscribe to.
 */
export function useReplenishStockMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReplenishPayload) =>
      $fetch<ReplenishStockResponse>('/api/stock/replenish', {
        method: 'POST',
        body: {
          companyCode: payload.companyCode,
          lines: [{ productCode: payload.productCode, units: payload.units }],
        } satisfies ReplenishStockRequest,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stock'] });
    },
  });
}
