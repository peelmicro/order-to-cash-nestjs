<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useCompaniesQuery, useProductsQuery, useRetailersQuery } from '@/composables/useCatalog';
import { usePlaceOrderMutation } from '@/composables/useOrders';
import { draftOrderTotal, formatMoney } from '@/lib/money';
import type { Problem, PlaceOrderLine } from '#shared/types/gateway';

definePageMeta({ layout: 'default' });

const { data: retailers, isError: retailersFailed } = useRetailersQuery();
const { data: companies, isError: companiesFailed } = useCompaniesQuery();
const { data: products, isError: productsFailed } = useProductsQuery();

// `GET /catalog/*` translates to the `catalog.reference.list` NATS subject,
// which — as of this pass — no service in the system registers a responder
// for (apps/gateway/src/application/queries/list-catalog.query.ts's own
// recorded gap: "the seeded catalogue lives only in apps/orders' write
// database, which this gateway may never read directly"). Verified live: the
// call correctly reaches the Gateway and comes back `503
// UPSTREAM_UNAVAILABLE` — the proxy and error-forwarding are proven working,
// there is simply nothing to answer yet. Falling back to a free-text code
// field keeps this page usable for a real end-to-end demo in the meantime,
// rather than a dead dropdown with nothing in it.
const retailersUsable = computed(() => !retailersFailed.value && (retailers.value?.length ?? 0) > 0);
const companiesUsable = computed(() => !companiesFailed.value && (companies.value?.length ?? 0) > 0);
const productsUsable = computed(() => !productsFailed.value && (products.value?.length ?? 0) > 0);
const catalogUnavailable = computed(() => retailersFailed.value || companiesFailed.value || productsFailed.value);

const priceByProductCode = computed(() => new Map((products.value ?? []).map((p) => [p.code, p.price])));

interface DraftLine extends PlaceOrderLine {
  quantity: number;
}

const form = reactive({
  retailerCode: '',
  companyCode: '',
  currency: 'EUR',
  notes: '',
});

const lines = ref<DraftLine[]>([{ productCode: '', quantity: 1 }]);

function addLine() {
  lines.value.push({ productCode: '', quantity: 1 });
}

function removeLine(index: number) {
  lines.value.splice(index, 1);
}

const runningTotal = computed(() =>
  draftOrderTotal(
    lines.value.filter((l) => l.productCode),
    priceByProductCode.value,
    0,
  ),
);

/**
 * R42's demo affordance — mirrors `scripts/place-order.mjs --qty 1` exactly:
 * one line, 1 × PRD-0001, `unitPrice` supplied explicitly as 24999 so the
 * total is exactly 24999 minor units — ends in `.99`, which the credit
 * simulator refuses, triggering the saga's compensation path (stock
 * released, order cancelled). Uses the seeded (CarrefourEs, IBERFOODS) pair
 * directly — the same defaults `scripts/place-order.mjs` falls back to —
 * so the fill works whether or not the live catalogue lookup is.
 */
function fillCompensationDemo() {
  form.retailerCode = retailers.value?.[0]?.code ?? 'CarrefourEs';
  form.companyCode = companies.value?.[0]?.code ?? 'IBERFOODS';
  form.notes = 'demo — compensation path (.99)';
  lines.value = [{ productCode: 'PRD-0001', quantity: 1, unitPrice: 24999 }];
}

const placeOrder = usePlaceOrderMutation();
const successOrderReference = ref<string | null>(null);

const errorDetail = computed(() => {
  const error = placeOrder.error.value as { data?: Problem } | null;
  return error?.data?.detail ?? error?.data?.title ?? (placeOrder.isError.value ? 'Placing the order failed.' : undefined);
});

async function submit() {
  successOrderReference.value = null;
  const payload = {
    retailerCode: form.retailerCode,
    companyCode: form.companyCode,
    currency: form.currency,
    notes: form.notes || undefined,
    lines: lines.value
      .filter((l) => l.productCode && l.quantity > 0)
      .map((l) => ({
        productCode: l.productCode,
        quantity: l.quantity,
        ...(l.unitPrice !== undefined ? { unitPrice: l.unitPrice } : {}),
        ...(l.lineDiscount ? { lineDiscount: l.lineDiscount } : {}),
      })),
  };

  const result = await placeOrder.mutateAsync({
    request: payload,
    idempotencyKey: crypto.randomUUID(),
  });

  successOrderReference.value = result.orderReference;
  lines.value = [{ productCode: '', quantity: 1 }];
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-semibold">
        Place order
      </h1>
      <Button variant="outline" @click="fillCompensationDemo">
        Fill demo order (.99 → compensation)
      </Button>
    </div>

    <p v-if="catalogUnavailable" class="text-sm text-muted-foreground" data-testid="catalog-unavailable">
      The catalogue lookup (`GET /catalog/*`) is currently unavailable upstream — no service has a live `catalog.reference.list` responder yet. Enter codes by hand below (e.g. retailer <code>CarrefourEs</code>, company <code>IBERFOODS</code>, product <code>PRD-0001</code>).
    </p>

    <Card>
      <CardHeader>
        <CardTitle>Order</CardTitle>
        <CardDescription>Translates to the `orders.create` command — 201 means accepted, not that the saga finished.</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="flex flex-col gap-6" @submit.prevent="submit">
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div class="flex flex-col gap-1.5">
              <Label>Retailer</Label>
              <Select v-if="retailersUsable" v-model="form.retailerCode">
                <SelectTrigger>
                  <SelectValue placeholder="Select a retailer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="retailer in retailers" :key="retailer.code" :value="retailer.code">
                    {{ retailer.name }} ({{ retailer.code }})
                  </SelectItem>
                </SelectContent>
              </Select>
              <Input v-else v-model="form.retailerCode" placeholder="e.g. CarrefourEs" />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label>Company</Label>
              <Select v-if="companiesUsable" v-model="form.companyCode">
                <SelectTrigger>
                  <SelectValue placeholder="Select a company" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="company in companies" :key="company.code" :value="company.code">
                    {{ company.name }} ({{ company.code }})
                  </SelectItem>
                </SelectContent>
              </Select>
              <Input v-else v-model="form.companyCode" placeholder="e.g. IBERFOODS" />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="currency">Currency</Label>
              <Input id="currency" v-model="form.currency" maxlength="3" class="uppercase" />
            </div>
          </div>

          <Separator />

          <div class="flex flex-col gap-3">
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium">Lines</span>
              <Button type="button" variant="outline" size="sm" @click="addLine">
                Add line
              </Button>
            </div>

            <div
              v-for="(line, index) in lines"
              :key="index"
              class="grid grid-cols-1 items-end gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]"
            >
              <div class="flex flex-col gap-1.5">
                <Label>Product</Label>
                <Select v-if="productsUsable" v-model="line.productCode">
                  <SelectTrigger>
                    <SelectValue placeholder="Select a product" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="product in products" :key="product.code" :value="product.code">
                      {{ product.name }} ({{ product.code }}) — {{ formatMoney(product.price, product.currency) }}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Input v-else v-model="line.productCode" placeholder="e.g. PRD-0001" />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label>Quantity</Label>
                <Input
                  :model-value="line.quantity"
                  type="number"
                  min="1"
                  @update:model-value="(v) => (line.quantity = Number(v))"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label>Unit price override</Label>
                <Input
                  :model-value="line.unitPrice"
                  type="number"
                  min="0"
                  placeholder="catalogue price"
                  @update:model-value="(v) => (line.unitPrice = v === '' ? undefined : Number(v))"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label>Line discount</Label>
                <Input
                  :model-value="line.lineDiscount"
                  type="number"
                  min="0"
                  placeholder="0"
                  @update:model-value="(v) => (line.lineDiscount = v === '' ? undefined : Number(v))"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                :disabled="lines.length <= 1"
                @click="removeLine(index)"
              >
                Remove
              </Button>
            </div>
          </div>

          <Separator />

          <div class="flex items-center justify-between">
            <span class="text-sm text-muted-foreground">Running total (client-side estimate — the server always computes the authoritative total)</span>
            <span class="text-lg font-semibold" data-testid="running-total">
              {{ formatMoney(runningTotal, form.currency) }}
            </span>
          </div>

          <div class="flex flex-col gap-1.5">
            <Label for="notes">Notes</Label>
            <Input id="notes" v-model="form.notes" />
          </div>

          <p v-if="errorDetail" class="text-sm text-destructive" data-testid="place-order-error">
            {{ errorDetail }}
          </p>
          <p v-if="successOrderReference" class="text-sm text-emerald-600" data-testid="place-order-success">
            Order {{ successOrderReference }} accepted. It is not queryable yet — check the
            <NuxtLink to="/orders" class="underline">
              order list
            </NuxtLink>
            in a moment.
          </p>

          <Button type="submit" :disabled="placeOrder.isPending.value || !form.retailerCode || !form.companyCode">
            {{ placeOrder.isPending.value ? 'Placing…' : 'Place order' }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
