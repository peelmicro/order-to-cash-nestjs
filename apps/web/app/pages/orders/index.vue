<script setup lang="ts">
import { computed, reactive } from 'vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useRetailersQuery } from '@/composables/useCatalog';
import { useOrdersQuery, type OrderListFilters } from '@/composables/useOrders';
import { formatMoney } from '@/lib/money';
import { describeFetchError } from '@/lib/problem';
import type { OrderStatus } from '#shared/types/gateway';

definePageMeta({ layout: 'default' });

const ORDER_STATUSES: OrderStatus[] = [
  'placed',
  'stock_reserved',
  'credit_approved',
  'confirmed',
  'despatched',
  'invoiced',
  'paid',
  'completed',
  'cancelled',
];

const filters = reactive<OrderListFilters>({
  status: undefined,
  retailerCode: undefined,
  page: 1,
  pageSize: 20,
});

// A separate ref so `useOrdersQuery`'s reactive queryKey only re-derives
// once per genuine change, not per keystroke of an unrelated field.
const filtersRef = computed<OrderListFilters>(() => ({ ...filters }));

const { data, isLoading, isFetching, isError, error } = useOrdersQuery(filtersRef);
const { data: retailers } = useRetailersQuery();

const statusFilterValue = computed<string>({
  get: () => filters.status?.[0] ?? 'all',
  set: (value) => {
    filters.status = value === 'all' ? undefined : [value as OrderStatus];
    filters.page = 1;
  },
});

const retailerFilterValue = computed<string>({
  get: () => filters.retailerCode ?? 'all',
  set: (value) => {
    filters.retailerCode = value === 'all' ? undefined : value;
    filters.page = 1;
  },
});

const totalPages = computed(() => {
  const page = data.value?.page;
  if (!page) return 1;
  return Math.max(1, Math.ceil(page.total / page.pageSize));
});

function statusVariant(status: OrderStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'cancelled') return 'destructive';
  if (status === 'completed' || status === 'paid') return 'secondary';
  return 'outline';
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-semibold">
        Orders
      </h1>
      <Button as-child>
        <NuxtLink to="/orders/place">
          Place order
        </NuxtLink>
      </Button>
    </div>

    <div class="flex flex-wrap items-end gap-4">
      <div class="flex flex-col gap-1.5">
        <span class="text-sm font-medium">Status</span>
        <Select v-model="statusFilterValue">
          <SelectTrigger class="w-48">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              All statuses
            </SelectItem>
            <SelectItem v-for="status in ORDER_STATUSES" :key="status" :value="status">
              {{ status }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex flex-col gap-1.5">
        <span class="text-sm font-medium">Retailer</span>
        <Select v-model="retailerFilterValue">
          <SelectTrigger class="w-56">
            <SelectValue placeholder="All retailers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              All retailers
            </SelectItem>
            <SelectItem v-for="retailer in retailers" :key="retailer.code" :value="retailer.code">
              {{ retailer.name }} ({{ retailer.code }})
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <span v-if="isFetching && !isLoading" class="text-xs text-muted-foreground">
        refreshing…
      </span>
    </div>

    <p v-if="isError" class="text-sm text-destructive" data-testid="orders-error">
      Could not load orders: {{ describeFetchError(error, 'the request failed') }}
    </p>

    <div v-else-if="isLoading" class="text-sm text-muted-foreground" data-testid="orders-loading">
      Loading…
    </div>

    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead>Reference</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Retailer</TableHead>
          <TableHead>Company</TableHead>
          <TableHead>Status</TableHead>
          <TableHead class="text-right">
            Total
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableEmpty v-if="!data?.items.length" :colspan="6">
          No orders match these filters.
        </TableEmpty>
        <TableRow v-for="order in data?.items" :key="order.orderId">
          <TableCell class="font-medium">
            <NuxtLink :to="`/orders/${order.orderId}`" class="hover:underline">
              {{ order.orderReference }}
            </NuxtLink>
          </TableCell>
          <TableCell>{{ new Date(order.orderDate).toLocaleString() }}</TableCell>
          <TableCell>{{ order.retailer.name ?? order.retailer.code }}</TableCell>
          <TableCell>{{ order.company.name ?? order.company.code }}</TableCell>
          <TableCell>
            <Badge :variant="statusVariant(order.status)">
              {{ order.status }}
            </Badge>
          </TableCell>
          <TableCell class="text-right">
            {{ formatMoney(order.totals.totalAmount, order.currency) }}
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>

    <div v-if="!isError" class="flex items-center justify-between">
      <span class="text-sm text-muted-foreground">
        Page {{ data?.page.page ?? filters.page }} of {{ totalPages }} · {{ data?.page.total ?? 0 }} orders
      </span>
      <div class="flex gap-2">
        <Button variant="outline" size="sm" :disabled="filters.page <= 1" @click="filters.page--">
          Previous
        </Button>
        <Button variant="outline" size="sm" :disabled="filters.page >= totalPages" @click="filters.page++">
          Next
        </Button>
      </div>
    </div>
  </div>
</template>
