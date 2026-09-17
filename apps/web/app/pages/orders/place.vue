<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useCompaniesQuery, useProductsQuery, useRetailersQuery } from '@/composables/useCatalog';
import { usePlaceOrderMutation } from '@/composables/useOrders';
import { currencyInputStep, decimalStringToMinorUnits, draftOrderTotal, formatMoney, minorUnitsToDecimalString } from '@/lib/money';
import { problemFromFetchError } from '@/lib/problem';
import type { StockUnavailableProblem } from '#shared/types/gateway';

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

/**
 * `unitPriceInput`/`lineDiscountInput` hold the human-typed decimal
 * major-unit string exactly as entered (e.g. `"249.99"`), never the raw
 * integer minor-units wire value — this is what fixed the "Unit price
 * override shows 24999 instead of 249.99" bug (and the identical,
 * previously-undiscovered issue on "Line discount", which bound to the same
 * raw-minor-units shape). Keeping the input bound to its own live string
 * (rather than a value re-derived from a parsed minor-units number on every
 * keystroke) also avoids the field fighting the user mid-type — e.g.
 * reformatting `"249."` back to `"249"` the instant the trailing decimal
 * point is typed. The minor-units integer these ultimately represent is
 * computed on demand, at the two points that actually need the wire/domain
 * shape: the running-total display and the submit payload (both via
 * `decimalStringToMinorUnits`, `@/lib/money.ts`).
 */
interface DraftLine {
  productCode: string;
  quantity: number;
  unitPriceInput: string;
  lineDiscountInput: string;
}

function emptyDraftLine(): DraftLine {
  return { productCode: '', quantity: 1, unitPriceInput: '', lineDiscountInput: '' };
}

const form = reactive({
  retailerCode: '',
  companyCode: '',
  currency: 'EUR',
  notes: '',
});

const lines = ref<DraftLine[]>([emptyDraftLine()]);

/**
 * Selected-value labels for the retailer/company/product `<Select>`s.
 * Computed here (rather than via `<SelectValue>`'s own scoped-slot
 * `selectedLabel`) because the vendored wrapper at
 * `app/components/ui/select/SelectValue.vue` renders a bare `<slot />`
 * with no `v-bind` — it does not forward reka-ui's scoped-slot props
 * through to a caller-provided `<template #default>`, so `selectedLabel`
 * would always be `undefined` there (confirmed live in a real browser: a
 * `<template #default="{ selectedLabel }">` on `<SelectValue>` rendered
 * `undefined` every time, never the actual option text). Deriving the
 * label independently here sidesteps that gap without touching the
 * vendored primitive.
 */
const retailerLabel = computed(() => {
  const selected = retailers.value?.find((r) => r.code === form.retailerCode);
  return selected ? `${selected.name} (${selected.code})` : undefined;
});
const companyLabel = computed(() => {
  const selected = companies.value?.find((c) => c.code === form.companyCode);
  return selected ? `${selected.name} (${selected.code})` : undefined;
});
function productLabel(productCode: string): string | undefined {
  const selected = products.value?.find((p) => p.code === productCode);
  return selected ? `${selected.name} (${selected.code}) — ${formatMoney(selected.price, selected.currency)}` : undefined;
}

/**
 * SSR-safe disabled-until-hydrated guard — same fix as `login.vue`'s (see
 * that file's comment for the full root-cause explanation). This form has
 * no password field, so the security angle doesn't apply, but the same
 * "first click does nothing until hydration finishes" UX bug does, since
 * this `<form>` also carries no `action`/`method` and relies on
 * `@submit.prevent` being attached as a live listener.
 */
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});

/**
 * Confirmed live: `AldiGb` trades in GBP, `CarrefourEs` in EUR — the retailer
 * carries its own trading currency (`GET /catalog/retailers`'s `Party.currency`,
 * `packages/contracts/src/generated/openapi.types.ts`). Selecting a retailer
 * whose currency differs from the field's current value (starting from the
 * `'EUR'` default) was previously a silent mismatch a user had no way to
 * notice before submitting. Re-derive the default from the selected retailer
 * every time the selection changes — the field stays a plain, editable
 * `Input` (a manual override after selection is still possible), only the
 * *default* it snaps to on selection is now correct instead of permanently
 * `'EUR'`.
 *
 * Known, deliberate-for-now limitation (not an oversight): this watcher
 * re-derives unconditionally on every retailer change, including a change
 * that happens *after* the user has manually overridden `form.currency` —
 * so a manual override is silently clobbered by re-selecting a retailer.
 * Correctly fixing this needs a `touched`/dirty flag plus a test for the
 * override-then-reselect path; deferred as a follow-up.
 */
watch(
  () => form.retailerCode,
  (retailerCode) => {
    const selected = retailers.value?.find((r) => r.code === retailerCode);
    if (selected) {
      form.currency = selected.currency;
    }
  },
);

function addLine() {
  lines.value.push(emptyDraftLine());
}

function removeLine(index: number) {
  lines.value.splice(index, 1);
}

const runningTotal = computed(() =>
  draftOrderTotal(
    lines.value
      .filter((l) => l.productCode)
      .map((l) => ({
        productCode: l.productCode,
        quantity: l.quantity,
        unitPrice: decimalStringToMinorUnits(l.unitPriceInput, form.currency),
        lineDiscount: decimalStringToMinorUnits(l.lineDiscountInput, form.currency),
      })),
    priceByProductCode.value,
    0,
  ),
);

/**
 * R42's demo affordance — mirrors `scripts/place-order.mjs --qty 1` exactly:
 * one line, 1 × PRD-0001, `unitPrice` supplied explicitly so the total is
 * exactly 24999 minor units — ends in `.99`, which the credit simulator
 * refuses, triggering the saga's compensation path (stock released, order
 * cancelled). Pre-fills the human-readable decimal `"249.99"` (not the raw
 * minor-units integer `24999`) — the field displays/accepts decimal amounts
 * like every other currency input, this button included. Uses the seeded
 * (CarrefourEs, IBERFOODS) pair directly — the same defaults
 * `scripts/place-order.mjs` falls back to — so the fill works whether or not
 * the live catalogue lookup is.
 */
function fillCompensationDemo() {
  form.retailerCode = retailers.value?.[0]?.code ?? 'CarrefourEs';
  form.companyCode = companies.value?.[0]?.code ?? 'IBERFOODS';
  form.notes = 'demo — compensation path (.99)';
  lines.value = [{ productCode: 'PRD-0001', quantity: 1, unitPriceInput: '249.99', lineDiscountInput: '' }];
}

const placeOrder = usePlaceOrderMutation();
const successOrderReference = ref<string | null>(null);

// `app/lib/problem.ts` — reads the server's own reason (RFC 9457 `detail`),
// not a naive `error.data?.detail` (this app's error-handling sweep found
// that misses a real, live-confirmed wrapping layer and silently falls
// through to the generic fallback on every error, everywhere).
const errorDetail = computed(() => (placeOrder.isError.value ? (problemFromFetchError(placeOrder.error.value)?.detail ?? problemFromFetchError(placeOrder.error.value)?.title ?? 'Placing the order failed.') : undefined));

/**
 * The 409/`STOCK_UNAVAILABLE` case named explicitly in this pass's brief:
 * the acceptance-time availability check failed. `openapi.yaml`'s
 * `StockUnavailableProblem` carries a `shortages` array (per-product
 * requested vs available) alongside the generic `detail` text — surfaced
 * here so the operator sees exactly which line(s) are short, not just "it
 * failed".
 */
const stockShortages = computed(() => {
  if (!placeOrder.isError.value) return undefined;
  const problem = problemFromFetchError(placeOrder.error.value) as StockUnavailableProblem | undefined;
  return problem?.shortages?.length ? problem.shortages : undefined;
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
      .map((l) => {
        const unitPrice = decimalStringToMinorUnits(l.unitPriceInput, form.currency);
        const lineDiscount = decimalStringToMinorUnits(l.lineDiscountInput, form.currency);
        return {
          productCode: l.productCode,
          quantity: l.quantity,
          ...(unitPrice !== undefined ? { unitPrice } : {}),
          ...(lineDiscount ? { lineDiscount } : {}),
        };
      }),
  };

  try {
    const result = await placeOrder.mutateAsync({
      request: payload,
      idempotencyKey: crypto.randomUUID(),
    });
    successOrderReference.value = result.orderReference;
    lines.value = [emptyDraftLine()];
  } catch {
    // `placeOrder.isError`/`.error` (read by `errorDetail`/`stockShortages`)
    // already drives the error UI — this only prevents an unhandled
    // promise rejection from `mutateAsync`'s own re-throw.
  }
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
              <!--
                The Select and the Input fallback are mutually exclusive
                (v-if/v-else on the same wrapping <template> — never both in
                the DOM at once), so each gets its OWN static id/label pair
                rather than one shared id or a dynamic `for`/`id` computed
                from a ternary: a shared id was a genuine duplicate-id defect
                (SonarQube Web:S7930) the first time this page tried it, and
                a dynamic `:for`/`:id` pair — while correctly matching at
                runtime — is invisible to a static id/label checker (it
                cannot evaluate a template expression), so it is undetectable
                as accessible even though it is. Two fully static pairs,
                grouped under <template> so `v-else` still binds to the
                right `v-if`, are both correct AND verifiable.
              -->
              <template v-if="retailersUsable">
                <Label for="retailer-select">Retailer</Label>
                <Select v-model="form.retailerCode">
                  <SelectTrigger id="retailer-select" class="w-full min-w-0" data-testid="retailer-select-trigger">
                    <SelectValue class="truncate" placeholder="Select a retailer" :title="retailerLabel ?? 'Select a retailer'" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="retailer in retailers" :key="retailer.code" :value="retailer.code">
                      {{ retailer.name }} ({{ retailer.code }})
                    </SelectItem>
                  </SelectContent>
                </Select>
              </template>
              <template v-else>
                <Label for="retailer-input">Retailer</Label>
                <Input id="retailer-input" v-model="form.retailerCode" placeholder="e.g. CarrefourEs" />
              </template>
            </div>
            <div class="flex flex-col gap-1.5">
              <template v-if="companiesUsable">
                <Label for="company-select">Company</Label>
                <Select v-model="form.companyCode">
                  <SelectTrigger id="company-select" class="w-full min-w-0" data-testid="company-select-trigger">
                    <SelectValue class="truncate" placeholder="Select a company" :title="companyLabel ?? 'Select a company'" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="company in companies" :key="company.code" :value="company.code">
                      {{ company.name }} ({{ company.code }})
                    </SelectItem>
                  </SelectContent>
                </Select>
              </template>
              <template v-else>
                <Label for="company-input">Company</Label>
                <Input id="company-input" v-model="form.companyCode" placeholder="e.g. IBERFOODS" />
              </template>
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
              class="grid grid-cols-1 items-end gap-3 sm:grid-cols-[2fr_1fr_1.5fr_1fr_auto]"
            >
              <div class="flex flex-col gap-1.5">
                <!--
                  Same reasoning as the Retailer/Company pair above: two
                  fully separate id/label pairs per branch, not one id
                  shared by both. This one is inside a `v-for`, so "static"
                  means "distinct per branch", with the loop `index`
                  appended to keep each pair unique across lines — never a
                  single id computed by a ternary between the two branches.
                -->
                <template v-if="productsUsable">
                  <Label :for="`product-select-field-${index}`">Product</Label>
                  <Select v-model="line.productCode">
                    <SelectTrigger :id="`product-select-field-${index}`" class="w-full min-w-0" data-testid="product-select-trigger">
                      <SelectValue class="truncate" placeholder="Select a product" :title="productLabel(line.productCode) ?? 'Select a product'" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="product in products" :key="product.code" :value="product.code">
                        {{ product.name }} ({{ product.code }}) — {{ formatMoney(product.price, product.currency) }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </template>
                <template v-else>
                  <Label :for="`product-input-field-${index}`">Product</Label>
                  <Input :id="`product-input-field-${index}`" v-model="line.productCode" placeholder="e.g. PRD-0001" />
                </template>
              </div>
              <div class="flex flex-col gap-1.5">
                <Label :for="`quantity-field-${index}`">Quantity</Label>
                <Input
                  :id="`quantity-field-${index}`"
                  :model-value="line.quantity"
                  type="number"
                  min="1"
                  data-testid="quantity-input"
                  @update:model-value="(v) => (line.quantity = Number(v))"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label :for="`unit-price-field-${index}`">Unit price override</Label>
                <Input
                  :id="`unit-price-field-${index}`"
                  :model-value="line.unitPriceInput"
                  type="number"
                  min="0"
                  :step="currencyInputStep(form.currency)"
                  placeholder="catalogue"
                  class="text-sm"
                  data-testid="unit-price-input"
                  @update:model-value="(v) => (line.unitPriceInput = String(v))"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label :for="`line-discount-field-${index}`">Line discount</Label>
                <Input
                  :id="`line-discount-field-${index}`"
                  :model-value="line.lineDiscountInput"
                  type="number"
                  min="0"
                  :step="currencyInputStep(form.currency)"
                  :placeholder="minorUnitsToDecimalString(0, form.currency)"
                  data-testid="line-discount-input"
                  @update:model-value="(v) => (line.lineDiscountInput = String(v))"
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

          <div v-if="errorDetail" class="flex flex-col gap-1 text-sm text-destructive" data-testid="place-order-error">
            <p>{{ errorDetail }}</p>
            <ul v-if="stockShortages" class="list-disc pl-5" data-testid="place-order-shortages">
              <li v-for="shortage in stockShortages" :key="shortage.productCode">
                {{ shortage.productCode }}: requested {{ shortage.requested }}, only {{ shortage.available }} available
              </li>
            </ul>
          </div>
          <p v-if="successOrderReference" class="text-sm text-emerald-600" data-testid="place-order-success">
            Order {{ successOrderReference }} accepted. It is not queryable yet — check the
            <NuxtLink to="/orders" class="underline">
              order list
            </NuxtLink>
            in a moment.
          </p>

          <Button
            type="submit"
            :disabled="placeOrder.isPending.value || !mounted || !form.retailerCode || !form.companyCode"
          >
            {{ placeOrder.isPending.value ? 'Placing…' : 'Place order' }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
