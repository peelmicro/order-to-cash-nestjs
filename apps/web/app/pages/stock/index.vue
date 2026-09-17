<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useProductsQuery } from '@/composables/useCatalog';
import { useReplenishStockMutation, useStockQuery, type StockListFilters } from '@/composables/useStock';
import { describeFetchError } from '@/lib/problem';
import type { ReplenishStockResponse, StockItem } from '#shared/types/gateway';

definePageMeta({ layout: 'default' });

const { data: products, isError: productsFailed, error: productsError } = useProductsQuery();
const productNameByCode = computed(() => new Map((products.value ?? []).map((product) => [product.code, product.name])));

/**
 * `StockItem.productName` (a backend fact, when one is ever sent) wins over the
 * catalog's own `name`; `undefined` when neither is known, so the caller shows
 * the code once rather than repeating it (id 101).
 */
function productDisplayName(item: Pick<StockItem, 'productName' | 'productCode'>): string | undefined {
  return item.productName ?? productNameByCode.value.get(item.productCode);
}

const filters = reactive<StockListFilters>({
  companyCode: undefined,
  productCode: undefined,
  belowThreshold: false,
  page: 1,
  pageSize: 20,
});

// Same "separate computed so the reactive queryKey only re-derives once per
// genuine change" pattern as `orders/index.vue`/`billing/index.vue`.
const filtersRef = computed<StockListFilters>(() => ({ ...filters }));

const { data, isLoading, isFetching, isError, error } = useStockQuery(filtersRef);

const totalPages = computed(() => {
  const page = data.value?.page;
  if (!page) return 1;
  return Math.max(1, Math.ceil(page.total / page.pageSize));
});

function toggleBelowThreshold(): void {
  filters.belowThreshold = !filters.belowThreshold;
  filters.page = 1;
}

function applyCompanyFilter(value: string): void {
  filters.companyCode = value.trim() || undefined;
  filters.page = 1;
}

function applyProductFilter(value: string): void {
  filters.productCode = value.trim() || undefined;
  filters.page = 1;
}

function stockRowKey(item: StockItem): string {
  return `${item.companyCode}:${item.productCode}`;
}

// ── Replenish (a DELTA, never a target level — surfaced explicitly, not
//    just documented, per the brief: "repeating a replenish silently
//    doubling someone's stock because the form looked like a target field
//    is exactly the kind of thing that reads as a bug later") ────────────
const activeItem = ref<StockItem | null>(null);
const unitsInput = ref('');
const lastResult = ref<{ item: StockItem; delta: number; response: ReplenishStockResponse } | null>(null);

const replenish = useReplenishStockMutation();

function openReplenishForm(item: StockItem): void {
  activeItem.value = item;
  unitsInput.value = '';
  lastResult.value = null;
  // Pass 6's own disclosed follow-up: a stale mutation error must not
  // reappear when the form is reopened (this pass's error-handling sweep,
  // applied here from the start rather than repeating the gap).
  replenish.reset();
}

function closeReplenishForm(): void {
  activeItem.value = null;
  lastResult.value = null;
}

// `app/lib/problem.ts` — the server's own reason, not a naive
// `error.data?.detail` (see that file for why the naive read misses it).
const replenishErrorDetail = computed(() => (replenish.isError.value ? describeFetchError(replenish.error.value, 'Replenishing stock failed.') : undefined));

async function submitReplenish(): Promise<void> {
  const item = activeItem.value;
  const delta = Number(unitsInput.value);
  if (!item || !Number.isFinite(delta) || delta <= 0) return;

  try {
    const response = await replenish.mutateAsync({
      companyCode: item.companyCode,
      productCode: item.productCode,
      units: delta,
    });
    lastResult.value = { item, delta, response };
  } catch {
    // The mutation's own reactive state (`replenish.isError`/`.error`,
    // read by `replenishErrorDetail`) already drives the error UI — this
    // only prevents an unhandled promise rejection from `mutateAsync`'s
    // own re-throw (error-handling sweep: none swallowed, but also none
    // left to reject silently in the console).
  }
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <h1 class="text-xl font-semibold">
      Stock
    </h1>
    <p class="text-sm text-muted-foreground">
      A live read of Fulfillment's own on-hand/reserved units — not the order-timeline read model, so there is no projection lag here. `availableUnits = units − reservedUnits` (invariant F1 keeps it non-negative).
    </p>

    <!-- A failed catalog read never hides the stock table below — rows fall back to the product code alone (id 101). -->
    <p v-if="productsFailed" class="text-sm text-destructive" data-testid="stock-products-error">
      Product names unavailable: {{ describeFetchError(productsError, 'the catalog could not be loaded') }}
    </p>

    <div class="flex flex-wrap items-end gap-4">
      <div class="flex flex-col gap-1.5">
        <Label for="stock-company-filter">Company</Label>
        <Input
          id="stock-company-filter"
          :model-value="filters.companyCode"
          placeholder="e.g. IBERFOODS"
          class="w-48"
          data-testid="stock-company-filter"
          @update:model-value="(v) => applyCompanyFilter(String(v))"
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="stock-product-filter">Product</Label>
        <Input
          id="stock-product-filter"
          :model-value="filters.productCode"
          placeholder="e.g. PRD-0001"
          class="w-48"
          data-testid="stock-product-filter"
          @update:model-value="(v) => applyProductFilter(String(v))"
        />
      </div>
      <Button
        type="button"
        :variant="filters.belowThreshold ? 'default' : 'outline'"
        data-testid="below-threshold-toggle"
        @click="toggleBelowThreshold"
      >
        {{ filters.belowThreshold ? '✓ ' : '' }}Low stock only (below threshold)
      </Button>

      <span v-if="isFetching && !isLoading" class="text-xs text-muted-foreground">
        refreshing…
      </span>
    </div>

    <p v-if="isError" class="text-sm text-destructive" data-testid="stock-error">
      Could not load stock: {{ describeFetchError(error, 'the request failed') }}
    </p>

    <div v-else-if="isLoading" class="text-sm text-muted-foreground" data-testid="stock-loading">
      Loading…
    </div>

    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead>Company</TableHead>
          <TableHead>Product</TableHead>
          <TableHead class="text-right">
            On hand
          </TableHead>
          <TableHead class="text-right">
            Reserved
          </TableHead>
          <TableHead class="text-right">
            Available
          </TableHead>
          <TableHead class="text-right">
            Threshold
          </TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableEmpty v-if="!data?.items.length" :colspan="7">
          No stock lines match these filters.
        </TableEmpty>
        <template v-for="item in data?.items" :key="stockRowKey(item)">
          <TableRow data-testid="stock-row">
            <TableCell>{{ item.companyCode }}</TableCell>
            <TableCell class="font-medium" data-testid="stock-product">
              <template v-if="productDisplayName(item)">
                {{ productDisplayName(item) }} <span class="text-xs text-muted-foreground">({{ item.productCode }})</span>
              </template>
              <template v-else>
                {{ item.productCode }}
              </template>
            </TableCell>
            <TableCell class="text-right" data-testid="stock-units">
              {{ item.units }}
            </TableCell>
            <TableCell class="text-right">
              {{ item.reservedUnits }}
            </TableCell>
            <TableCell class="text-right" data-testid="stock-available">
              <Badge :variant="item.availableUnits < item.lowStockThreshold ? 'destructive' : 'secondary'">
                {{ item.availableUnits }}
              </Badge>
            </TableCell>
            <TableCell class="text-right text-muted-foreground">
              {{ item.lowStockThreshold }}
            </TableCell>
            <TableCell>
              <Button
                v-if="activeItem?.productCode !== item.productCode || activeItem?.companyCode !== item.companyCode"
                size="sm"
                variant="outline"
                data-testid="replenish-button"
                @click="openReplenishForm(item)"
              >
                Replenish
              </Button>
            </TableCell>
          </TableRow>

          <TableRow v-if="activeItem?.productCode === item.productCode && activeItem?.companyCode === item.companyCode">
            <TableCell :colspan="7">
              <div class="flex flex-col gap-3 rounded-md border p-4" data-testid="replenish-form">
                <template v-if="!lastResult">
                  <p class="text-xs text-muted-foreground">
                    This <strong>adds</strong> to on-hand stock — it is a delta, not a target level. Submitting the same amount twice adds it twice; reservations are untouched.
                  </p>
                  <div class="flex items-end gap-3">
                    <div class="flex flex-col gap-1.5">
                      <Label for="replenish-units">Units to add</Label>
                      <Input
                        id="replenish-units"
                        v-model="unitsInput"
                        type="number"
                        min="1"
                        step="1"
                        placeholder="e.g. 100"
                        data-testid="replenish-units-input"
                      />
                    </div>
                    <Button
                      type="button"
                      data-testid="submit-replenish-button"
                      :disabled="replenish.isPending.value || !unitsInput"
                      @click="submitReplenish"
                    >
                      {{ replenish.isPending.value ? 'Adding…' : 'Add units' }}
                    </Button>
                    <Button type="button" variant="ghost" @click="closeReplenishForm">
                      Cancel
                    </Button>
                  </div>
                  <p v-if="replenishErrorDetail" class="text-sm text-destructive" data-testid="replenish-error">
                    {{ replenishErrorDetail }}
                  </p>
                </template>

                <template v-else>
                  <p class="text-sm text-emerald-600" data-testid="replenish-outcome">
                    Added {{ lastResult.delta }} units to {{ lastResult.item.productCode }} — on-hand is now {{ lastResult.response.items.find((i) => i.productCode === lastResult?.item.productCode)?.units ?? '…' }}.
                  </p>
                  <Button type="button" size="sm" variant="outline" @click="closeReplenishForm">
                    Close
                  </Button>
                </template>
              </div>
            </TableCell>
          </TableRow>
        </template>
      </TableBody>
    </Table>

    <div v-if="!isError" class="flex items-center justify-between">
      <span class="text-sm text-muted-foreground">
        Page {{ data?.page.page ?? filters.page }} of {{ totalPages }} · {{ data?.page.total ?? 0 }} stock lines
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
