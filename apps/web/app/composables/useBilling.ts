import { computed, type Ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { CreditPage, InvoicePage, InvoiceStatus, RegisterPaymentRequest, RegisterPaymentResponse } from '#shared/types/gateway';

export interface InvoiceListFilters {
  status?: InvoiceStatus;
  retailerCode?: string;
  page: number;
  pageSize: number;
}

/**
 * `GET /invoices` (R47/R48/R49's own view — statuses only change via
 * `POST /invoices/{id}/payments`, there is no internal timer), through the
 * server proxy. Polling refetch, not SSE — the decision the leader's brief
 * fixed for this pass: the spec defines exactly one stream endpoint
 * (`/orders/stream`, order events only), so this follows
 * `useOrdersQuery`'s (`useOrders.ts`) own established polling pattern
 * rather than inventing a second streaming mechanism.
 */
export function useInvoicesQuery(filters: Ref<InvoiceListFilters>) {
  return useQuery({
    queryKey: computed(() => ['invoices', filters.value]),
    queryFn: () =>
      $fetch<InvoicePage>('/api/invoices', {
        query: {
          status: filters.value.status || undefined,
          retailerCode: filters.value.retailerCode || undefined,
          page: filters.value.page,
          pageSize: filters.value.pageSize,
        },
      }),
    refetchInterval: 4_000,
    placeholderData: (previous) => previous,
  });
}

export interface CreditListFilters {
  retailerCode?: string;
  page: number;
  pageSize: number;
}

/**
 * `GET /credits` — credit limits and the amount currently held, per
 * retailer. Same polling convention as `useInvoicesQuery`.
 *
 * Paginated (`page`/`pageSize`, both spec-supported query params) rather
 * than the earlier fixed `pageSize: 200` fetch-everything shape — Pass 6's
 * review flagged that as rendering all 154 seeded credit rows above the
 * invoice table with no way to narrow them, "correct and within contract,
 * but... a `retailerCode` filter or a collapsed default would suit a demo
 * better". `retailerCode` (also spec-supported) is now an optional filter,
 * consistent with `useInvoicesQuery`'s own filter/pagination shape.
 */
export function useCreditsQuery(filters: Ref<CreditListFilters>) {
  return useQuery({
    queryKey: computed(() => ['credits', filters.value]),
    queryFn: () =>
      $fetch<CreditPage>('/api/credits', {
        query: {
          retailerCode: filters.value.retailerCode || undefined,
          page: filters.value.page,
          pageSize: filters.value.pageSize,
        },
      }),
    refetchInterval: 4_000,
    placeholderData: (previous) => previous,
  });
}

export interface RegisterPaymentPayload {
  invoiceId: string;
  request: RegisterPaymentRequest;
}

/**
 * `POST /invoices/{id}/payments` (R47). Returns quickly — `outcome:
 * 'accepted'`/`'duplicate'` — but the order only reaches `completed` later,
 * via the saga; this mutation does not invent a second progress mechanism
 * for that (the brief's own instruction), it only invalidates the
 * invoice/credit lists so the next poll shows the invoice as `paid` and the
 * credit hold released.
 */
export function useRegisterPaymentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ invoiceId, request }: RegisterPaymentPayload) =>
      $fetch<RegisterPaymentResponse>(`/api/invoices/${invoiceId}/payments`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['credits'] });
    },
  });
}
