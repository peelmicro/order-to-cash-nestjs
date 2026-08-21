// The application's requirement of the outside world for the five outbound
// saga commands (design.md §6.1). One method per NATS subject, typed
// end-to-end by `@otc/contracts`. The adapter (nats-saga-commands.adapter.ts)
// lands in infrastructure/messaging, reusing feature 15's
// NatsStockAvailabilityAdapter shape verbatim.
import type {
  CreditHoldReplyPayload,
  CreditHoldRequestPayload,
  DespatchCreateReplyPayload,
  DespatchCreateRequestPayload,
  InvoiceIssueReplyPayload,
  InvoiceIssueRequestPayload,
  StockReleaseReplyPayload,
  StockReleaseRequestPayload,
  StockReserveReplyPayload,
  StockReserveRequestPayload,
} from '@otc/contracts';

export const SAGA_COMMANDS = Symbol('SagaCommands');

export interface SagaCommandsPort {
  reserveStock(request: StockReserveRequestPayload): Promise<StockReserveReplyPayload>;
  releaseStock(request: StockReleaseRequestPayload): Promise<StockReleaseReplyPayload>;
  createDespatch(request: DespatchCreateRequestPayload): Promise<DespatchCreateReplyPayload>;
  holdCredit(request: CreditHoldRequestPayload): Promise<CreditHoldReplyPayload>;
  issueInvoice(request: InvoiceIssueRequestPayload): Promise<InvoiceIssueReplyPayload>;
}

/** The caller observed no reply within its deadline (SO4) — distinct from a transport error so the dispatcher's retry/park bookkeeping can log which one happened. */
export class SagaCommandTimeoutError extends Error {
  readonly code = 'SAGA_COMMAND_TIMEOUT';

  constructor(
    readonly subject: string,
    readonly timeoutMs: number,
  ) {
    super(`saga command: no reply within ${timeoutMs}ms on subject "${subject}"`);
    this.name = new.target.name;
  }
}

/** Any other transport-level failure — no responder subscribed (NATS `NoResponders`), a malformed reply, a connection error, or an `RpcError`-shaped body (design.md §6.1). */
export class SagaCommandTransportError extends Error {
  readonly code = 'SAGA_COMMAND_TRANSPORT_ERROR';

  constructor(
    readonly subject: string,
    reason: string,
  ) {
    super(`saga command: transport failure on subject "${subject}": ${reason}`);
    this.name = new.target.name;
  }
}
