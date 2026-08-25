// `POST /invoices/{id}/payments` (openapi.yaml `registerPayment`) → NATS
// RPC `billing.payment.register` (asyncapi.yaml `requestPaymentRegister`,
// R47-R49). The path carries only `invoiceId` (a Billing-internal UUID),
// but `saga.md`'s invariant is `correlationId = orderId`, and
// `apps/billing/src/presentation/rpc-meta.ts`'s `parseRpcMeta` REJECTS a
// request with no `x-correlation-id` header at all — so this handler must
// resolve the order id BEFORE calling `billing.payment.register`, not
// after.
//
// **The known gap this closes (and the one still open in it).** There is
// no "get invoice by id" RPC query in asyncapi.yaml — only
// `billing.invoice.list`, filterable by `status`/`retailerCode`/
// `companyCode`/`orderReference`/`issuedBeforeMinutes`, never by
// `invoiceId` — and the read model never learns `invoiceId` at all (only
// `invoiceReference`, projected from `invoice.issued.v1`'s payload, which
// itself carries no `invoiceId` either — asyncapi.yaml
// `InvoiceIssuedPayload`). So step 1 below is necessarily a BOUNDED SCAN
// of `billing.invoice.list` — an RPC call to Billing's own read query, not
// a write-database read, but still O(invoices) rather than O(1). Once the
// matching `InvoiceView.orderReference` is found, step 2 resolves the
// REAL order id from the read model's own `_id` (R54's read-model-only
// rule), exactly as directed. Recorded in
// progress/impl_gateway_rest_auth.md as a contract gap for the reviewer:
// a `billing.invoice.get`-by-id RPC subject (or a `invoiceId` filter on
// `billing.invoice.list`) would remove the scan entirely.
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { UniqueId } from '@otc/shared-kernel';
import type { InvoiceListReplyPayload, InvoiceListRequestPayload, PaymentRegisterReplyPayload, PaymentRegisterRequestPayload } from '@otc/contracts';
import { ORDER_READ_MODEL, type OrderReadModel } from '../ports/order-read-model.port';
import { RPC_CLIENT, type RpcClient } from '../ports/rpc-client.port';

export const INVOICE_LIST_SUBJECT = 'billing.invoice.list';
export const PAYMENT_REGISTER_SUBJECT = 'billing.payment.register';

const INVOICE_SCAN_PAGE_SIZE = 200;
const INVOICE_SCAN_MAX_PAGES = 5;

/** Genuinely not found: the scan reached the END of `billing.invoice.list` (a page shorter than `INVOICE_SCAN_PAGE_SIZE`) without a match — there is nothing left to find. This is the ONLY branch that may honestly claim the invoice does not exist. */
export class InvoiceNotFoundError extends Error {
  constructor(readonly invoiceId: string) {
    super(`no invoice for id "${invoiceId}"`);
  }
}

/**
 * F4 (review) — the scan hit `INVOICE_SCAN_MAX_PAGES` while the LAST page
 * fetched was still full (`items.length === INVOICE_SCAN_PAGE_SIZE`),
 * meaning `billing.invoice.list` may hold MORE invoices beyond the search
 * window. Unlike `InvoiceNotFoundError`, this does NOT claim the invoice
 * does not exist — it may exist, just not within the most recent
 * `scannedCount` invoices this handler was willing to page through. A
 * `404` would be a false statement here; this is reported as a distinct,
 * honestly-labelled failure (mapped to `503` by `ProblemJsonExceptionFilter`
 * — "could not resolve within the scan budget", never "not found").
 */
export class InvoiceScanBudgetExceededError extends Error {
  constructor(
    readonly invoiceId: string,
    readonly scannedCount: number,
  ) {
    super(`invoice "${invoiceId}" was not found within the ${scannedCount} most recently issued invoices scanned — it may exist beyond this gateway's search window`);
  }
}

export class OrderNotYetProjectedError extends Error {
  constructor(readonly orderReference: string) {
    super(`order "${orderReference}" is not yet projected into the read model — retry`);
  }
}

export interface RegisterPaymentRequestBody {
  readonly paymentReference: string;
  readonly amount: { readonly amount: number; readonly currency: string };
  readonly valueDate: string;
  readonly source: 'operator' | 'robot' | 'test';
}

export class RegisterPaymentCommand {
  constructor(
    readonly invoiceId: string,
    readonly body: RegisterPaymentRequestBody,
  ) {}
}

@CommandHandler(RegisterPaymentCommand)
export class RegisterPaymentHandler implements ICommandHandler<RegisterPaymentCommand, { reply: PaymentRegisterReplyPayload; correlationId: string }> {
  constructor(
    @Inject(RPC_CLIENT) private readonly rpc: RpcClient,
    @Inject(ORDER_READ_MODEL) private readonly readModel: OrderReadModel,
  ) {}

  async execute(command: RegisterPaymentCommand): Promise<{ reply: PaymentRegisterReplyPayload; correlationId: string }> {
    const orderReference = await this.resolveOrderReference(command.invoiceId);
    const order = await this.readModel.findByOrderReference(orderReference);
    if (!order) {
      throw new OrderNotYetProjectedError(orderReference);
    }
    const orderId = order.orderId;

    const payload: PaymentRegisterRequestPayload = {
      invoiceId: command.invoiceId,
      paymentReference: command.body.paymentReference,
      amount: command.body.amount,
      valueDate: command.body.valueDate,
      source: command.body.source,
    };

    const reply = await this.rpc.call<PaymentRegisterRequestPayload, PaymentRegisterReplyPayload>(
      PAYMENT_REGISTER_SUBJECT,
      payload,
      { correlationId: orderId, requestId: UniqueId.generate().value },
    );

    return { reply, correlationId: orderId };
  }

  private async resolveOrderReference(invoiceId: string): Promise<string> {
    let scannedCount = 0;
    for (let page = 1; page <= INVOICE_SCAN_MAX_PAGES; page += 1) {
      const requestId = UniqueId.generate().value;
      const listPayload: InvoiceListRequestPayload = { page, pageSize: INVOICE_SCAN_PAGE_SIZE };
      const listReply = await this.rpc.call<InvoiceListRequestPayload, InvoiceListReplyPayload>(
        INVOICE_LIST_SUBJECT,
        listPayload,
        { correlationId: requestId, requestId },
      );
      scannedCount += listReply.items.length;
      const match = listReply.items.find((item) => item.invoiceId === invoiceId);
      if (match) {
        return match.orderReference;
      }
      if (listReply.items.length < INVOICE_SCAN_PAGE_SIZE) {
        // Genuinely exhausted: `billing.invoice.list` had nothing left to
        // page through. Honest to say "not found" here.
        throw new InvoiceNotFoundError(invoiceId);
      }
    }
    // The scan bound was reached while the LAST page was still full —
    // there may be more invoices beyond it. Honest to say "not found
    // within the search window", dishonest to say "not found".
    throw new InvoiceScanBudgetExceededError(invoiceId, scannedCount);
  }
}
