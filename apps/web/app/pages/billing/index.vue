<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useCreditsQuery, useInvoicesQuery, useRegisterPaymentMutation, type CreditListFilters, type InvoiceListFilters } from '@/composables/useBilling';
import { useRetailersQuery } from '@/composables/useCatalog';
import { useOrderByReferenceQuery } from '@/composables/useOrders';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { currencyInputStep, decimalStringToMinorUnits, formatMoney, minorUnitsToDecimalString } from '@/lib/money';
import { describeFetchError } from '@/lib/problem';
import type { Invoice, InvoiceStatus, RegisterPaymentResponse } from '#shared/types/gateway';

definePageMeta({ layout: 'default' });

const INVOICE_STATUSES: InvoiceStatus[] = ['issued', 'paid'];

const filters = reactive<InvoiceListFilters>({
  status: undefined,
  retailerCode: undefined,
  page: 1,
  pageSize: 20,
});

// Same "separate computed so the reactive queryKey only re-derives once per
// genuine change" pattern as `orders/index.vue`'s own `filtersRef`.
const filtersRef = computed<InvoiceListFilters>(() => ({ ...filters }));

const { data, isLoading, isFetching, isError, error } = useInvoicesQuery(filtersRef);
const { data: retailers } = useRetailersQuery();

// Paginated + filterable, not a fixed `pageSize: 200` fetch-everything call
// (Pass 6 review, non-blocking finding #2: 154 rows dominated the page with
// no way to narrow them).
const creditFilters = reactive<CreditListFilters>({ retailerCode: undefined, page: 1, pageSize: 20 });
const creditFiltersRef = computed<CreditListFilters>(() => ({ ...creditFilters }));
const { data: credits, isLoading: creditsLoading, isError: creditsError, error: creditsErrorDetail } = useCreditsQuery(creditFiltersRef);
const creditTotalPages = computed(() => {
  const page = credits.value?.page;
  if (!page) return 1;
  return Math.max(1, Math.ceil(page.total / page.pageSize));
});
const creditRetailerFilterValue = computed<string>({
  get: () => creditFilters.retailerCode ?? 'all',
  set: (value) => {
    creditFilters.retailerCode = value === 'all' ? undefined : value;
    creditFilters.page = 1;
  },
});

const statusFilterValue = computed<string>({
  get: () => filters.status ?? 'all',
  set: (value) => {
    filters.status = value === 'all' ? undefined : (value as InvoiceStatus);
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

function invoiceStatusVariant(status: InvoiceStatus): 'default' | 'secondary' | 'outline' {
  return status === 'paid' ? 'secondary' : 'outline';
}

// ── Register payment (R47/R48/R49) ─────────────────────────────────────────

/**
 * A sensible, operator-overwritable default — not the idempotency key
 * itself, only a starting point. `paymentReference` in the request body IS
 * the idempotency key (invariant B10, R48): the operator, an API test and
 * the demo payment robot all behave identically by that one field, which is
 * exactly why this is pre-filled rather than generated invisibly. Shape
 * mirrors openapi.yaml's own example (`PAY-2026-08-18-000019`).
 */
function suggestPaymentReference(invoice: Invoice): string {
  const today = new Date().toISOString().slice(0, 10);
  const suffix = invoice.invoiceReference.replace(/^INV-/, '');
  return `PAY-${today}-${suffix}`;
}

const activeInvoice = ref<Invoice | null>(null);
const paymentForm = reactive({ paymentReference: '', amountInput: '' });
const lastResult = ref<{ invoiceId: string; response: RegisterPaymentResponse } | null>(null);

function openPaymentForm(invoice: Invoice): void {
  activeInvoice.value = invoice;
  paymentForm.paymentReference = suggestPaymentReference(invoice);
  paymentForm.amountInput = minorUnitsToDecimalString(invoice.totalAmount, invoice.currency);
  lastResult.value = null;
  // Pass 6 review, non-blocking finding #1: a rejected remittance's error
  // used to survive across `closePaymentForm`/`openPaymentForm` and
  // reappear on a fresh attempt against a DIFFERENT invoice. `reset()`
  // clears the mutation's own state so a stale failure never bleeds into
  // the next open.
  registerPayment.reset();
}

function closePaymentForm(): void {
  activeInvoice.value = null;
  lastResult.value = null;
}

const registerPayment = useRegisterPaymentMutation();

// `app/lib/problem.ts` — the server's own reason (e.g. R49's `409`/`422`
// rejection detail), not a naive `error.data?.detail` (see that file for
// why the naive read always misses it).
const paymentErrorDetail = computed(() => (registerPayment.isError.value ? describeFetchError(registerPayment.error.value, 'Registering the payment failed.') : undefined));

async function submitPayment(): Promise<void> {
  const invoice = activeInvoice.value;
  if (!invoice) return;
  const amount = decimalStringToMinorUnits(paymentForm.amountInput, invoice.currency);
  if (amount === undefined) return;

  try {
    const response = await registerPayment.mutateAsync({
      invoiceId: invoice.invoiceId,
      request: {
        paymentReference: paymentForm.paymentReference,
        amount: { amount, currency: invoice.currency },
        valueDate: new Date().toISOString(),
        source: 'operator',
      },
    });
    lastResult.value = { invoiceId: invoice.invoiceId, response };
  } catch {
    // `registerPayment.isError`/`.error` (read by `paymentErrorDetail`)
    // already drives the error UI — this only prevents an unhandled
    // promise rejection from `mutateAsync`'s own re-throw.
  }
}

// The POST returns quickly (`outcome`), but the order only reaches
// `completed` afterwards via the saga (openapi.yaml). Rather than inventing
// a second progress mechanism, this resolves the `orderId` the just-paid
// invoice's `orderReference` maps to (invoices carry only the business
// reference, per `listInvoices`'s own description) and links straight to
// the order-detail page's existing live SSE timeline (Pass 3).
const linkedOrderReference = computed(() => lastResult.value?.response.orderReference);
const { data: linkedOrderId, isLoading: linkedOrderResolving } = useOrderByReferenceQuery(linkedOrderReference);
</script>

<template>
  <div class="flex flex-col gap-6">
    <h1 class="text-xl font-semibold">
      Billing
    </h1>

    <Card>
      <CardHeader>
        <CardTitle>Credit limits</CardTitle>
        <CardDescription>
          `availableCredit = creditLimit − activeHolds − openExposure` (invariant B1). A maxed-out line here is exactly what causes a `credit_rejected` cancellation on an order — visible here before it happens on the order list.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <div class="flex flex-wrap items-end gap-4">
          <div class="flex flex-col gap-1.5">
            <Label for="credit-retailer-filter">Retailer</Label>
            <Select v-model="creditRetailerFilterValue">
              <SelectTrigger id="credit-retailer-filter" class="w-56" data-testid="credit-retailer-filter-trigger">
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
        </div>

        <p v-if="creditsError" class="text-sm text-destructive" data-testid="credits-error">
          Could not load credit limits: {{ describeFetchError(creditsErrorDetail, 'the request failed') }}
        </p>

        <div v-else-if="creditsLoading" class="text-sm text-muted-foreground" data-testid="credits-loading">
          Loading…
        </div>

        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Retailer</TableHead>
              <TableHead>Company</TableHead>
              <TableHead class="text-right">
                Limit
              </TableHead>
              <TableHead class="text-right">
                Held
              </TableHead>
              <TableHead class="text-right">
                Open exposure
              </TableHead>
              <TableHead class="text-right">
                Available
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableEmpty v-if="!credits?.items.length" :colspan="6">
              No credit lines match this filter.
            </TableEmpty>
            <TableRow v-for="credit in credits?.items" :key="credit.creditCode" data-testid="credit-row">
              <TableCell>{{ credit.retailerCode }}</TableCell>
              <TableCell>{{ credit.companyCode }}</TableCell>
              <TableCell class="text-right">
                {{ formatMoney(credit.creditLimit, credit.currency) }}
              </TableCell>
              <TableCell class="text-right" data-testid="credit-held">
                {{ formatMoney(credit.activeHolds, credit.currency) }}
              </TableCell>
              <TableCell class="text-right">
                {{ formatMoney(credit.openExposure, credit.currency) }}
              </TableCell>
              <TableCell class="text-right" :class="credit.availableCredit === 0 ? 'font-medium text-destructive' : ''" data-testid="credit-available">
                {{ formatMoney(credit.availableCredit, credit.currency) }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <div v-if="!creditsError" class="flex items-center justify-between">
          <span class="text-sm text-muted-foreground">
            Page {{ credits?.page.page ?? creditFilters.page }} of {{ creditTotalPages }} · {{ credits?.page.total ?? 0 }} credit lines
          </span>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" :disabled="creditFilters.page <= 1" data-testid="credits-prev" @click="creditFilters.page--">
              Previous
            </Button>
            <Button variant="outline" size="sm" :disabled="creditFilters.page >= creditTotalPages" data-testid="credits-next" @click="creditFilters.page++">
              Next
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>

    <div class="flex flex-wrap items-end gap-4">
      <div class="flex flex-col gap-1.5">
        <Label for="invoice-status-filter">Status</Label>
        <Select v-model="statusFilterValue">
          <SelectTrigger id="invoice-status-filter" class="w-48">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              All statuses
            </SelectItem>
            <SelectItem v-for="status in INVOICE_STATUSES" :key="status" :value="status">
              {{ status }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="invoice-retailer-filter">Retailer</Label>
        <Select v-model="retailerFilterValue">
          <SelectTrigger id="invoice-retailer-filter" class="w-56">
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

    <p v-if="isError" class="text-sm text-destructive" data-testid="invoices-error">
      Could not load invoices: {{ describeFetchError(error, 'the request failed') }}
    </p>

    <div v-else-if="isLoading" class="text-sm text-muted-foreground" data-testid="invoices-loading">
      Loading…
    </div>

    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Order</TableHead>
          <TableHead>Retailer</TableHead>
          <TableHead>Company</TableHead>
          <TableHead>Issued</TableHead>
          <TableHead class="text-right">
            Total
          </TableHead>
          <TableHead>Status</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableEmpty v-if="!data?.items.length" :colspan="8">
          No invoices match these filters.
        </TableEmpty>
        <template v-for="invoice in data?.items" :key="invoice.invoiceId">
          <TableRow data-testid="invoice-row">
            <TableCell class="font-medium">
              {{ invoice.invoiceReference }}
            </TableCell>
            <TableCell>{{ invoice.orderReference }}</TableCell>
            <TableCell>{{ invoice.retailerCode }}</TableCell>
            <TableCell>{{ invoice.companyCode }}</TableCell>
            <TableCell>{{ new Date(invoice.invoiceDate).toLocaleString() }}</TableCell>
            <TableCell class="text-right" data-testid="invoice-total">
              {{ formatMoney(invoice.totalAmount, invoice.currency) }}
            </TableCell>
            <TableCell>
              <Badge :variant="invoiceStatusVariant(invoice.status)">
                {{ invoice.status }}
              </Badge>
            </TableCell>
            <TableCell>
              <Button
                v-if="invoice.status === 'issued' && activeInvoice?.invoiceId !== invoice.invoiceId"
                size="sm"
                variant="outline"
                data-testid="register-payment-button"
                @click="openPaymentForm(invoice)"
              >
                Register payment
              </Button>
            </TableCell>
          </TableRow>

          <TableRow v-if="activeInvoice?.invoiceId === invoice.invoiceId">
            <TableCell :colspan="8">
              <div class="flex flex-col gap-3 rounded-md border p-4" data-testid="payment-form">
                <template v-if="!lastResult || lastResult.invoiceId !== invoice.invoiceId">
                  <div class="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
                    <div class="flex flex-col gap-1.5">
                      <Label for="payment-reference">Payment reference</Label>
                      <Input
                        id="payment-reference"
                        v-model="paymentForm.paymentReference"
                        data-testid="payment-reference-input"
                      />
                    </div>
                    <div class="flex flex-col gap-1.5">
                      <Label for="payment-amount">Amount ({{ invoice.currency }})</Label>
                      <!--
                        `:model-value`/`@update:model-value` rather than plain
                        `v-model`, deliberately — Pass 5's own fix
                        (`orders/place.vue`) established why: Vue's native
                        `v-model` on `<input type="number">` auto-casts via
                        `looseToNumber` even without a `.number` modifier,
                        which would silently turn this held decimal STRING
                        into a float the moment the user types, defeating
                        `decimalStringToMinorUnits`'s whole point (it expects
                        a string, and never touches a fractional float).
                      -->
                      <Input
                        id="payment-amount"
                        :model-value="paymentForm.amountInput"
                        type="number"
                        min="0"
                        :step="currencyInputStep(invoice.currency)"
                        data-testid="payment-amount-input"
                        @update:model-value="(v) => (paymentForm.amountInput = String(v))"
                      />
                    </div>
                    <div class="flex gap-2">
                      <Button
                        type="button"
                        data-testid="submit-payment-button"
                        :disabled="registerPayment.isPending.value || !paymentForm.paymentReference || !paymentForm.amountInput"
                        @click="submitPayment"
                      >
                        {{ registerPayment.isPending.value ? 'Registering…' : 'Submit payment' }}
                      </Button>
                      <Button type="button" variant="ghost" @click="closePaymentForm">
                        Cancel
                      </Button>
                    </div>
                  </div>
                  <p v-if="paymentErrorDetail" class="text-sm text-destructive" data-testid="payment-error">
                    {{ paymentErrorDetail }}
                  </p>
                </template>

                <template v-else>
                  <!--
                    R48/B10 made visible, not just implemented server-side:
                    `outcome` distinguishes a genuinely new payment from a
                    replayed `paymentReference` that changed nothing — the
                    operator is told explicitly that no second payment was
                    created, rather than seeing the same "recorded" message
                    twice with no way to tell them apart.
                  -->
                  <p v-if="lastResult.response.outcome === 'accepted'" class="text-sm text-emerald-600" data-testid="payment-outcome-accepted">
                    Payment {{ lastResult.response.paymentReference }} recorded — invoice {{ lastResult.response.invoiceReference }} is now {{ lastResult.response.invoiceStatus }}.
                  </p>
                  <p v-else class="text-sm text-amber-600" data-testid="payment-outcome-duplicate">
                    Payment reference {{ lastResult.response.paymentReference }} was already recorded — no new payment was created (idempotent replay, invariant B10).
                  </p>
                  <p class="text-sm text-muted-foreground">
                    The order only reaches "completed" once the saga catches up —
                    <NuxtLink v-if="linkedOrderId" :to="`/orders/${linkedOrderId}`" class="underline" data-testid="view-order-link">
                      watch it finish on the order's live timeline
                    </NuxtLink>
                    <span v-else-if="linkedOrderResolving">resolving the order link…</span>
                  </p>
                  <Button type="button" size="sm" variant="outline" @click="closePaymentForm">
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
        Page {{ data?.page.page ?? filters.page }} of {{ totalPages }} · {{ data?.page.total ?? 0 }} invoices
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
