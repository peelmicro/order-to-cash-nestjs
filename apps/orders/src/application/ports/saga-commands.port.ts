// The application's requirement of the outside world for the five outbound
// saga commands (design.md §6.1). One method per NATS subject, typed
// end-to-end by `@otc/contracts`. The adapter (nats-saga-commands.adapter.ts)
// lands in infrastructure/messaging, reusing feature 15's
// NatsStockAvailabilityAdapter shape verbatim.
import type { UniqueId } from '@otc/shared-kernel';
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

/** `RpcHeaders`' `x-correlation-id`/`x-request-id` (asyncapi.yaml), carried on every saga command request (FS2). `correlationId` is the order id; `requestId` is the id of the durable `saga_commands` row being dispatched — stable across every in-line retry and sweeper re-issue of that row, which is what lets a responder recognise a duplicate. */
export interface SagaCommandMeta {
  readonly correlationId: UniqueId;
  readonly requestId: UniqueId;
}

export interface SagaCommandsPort {
  reserveStock(request: StockReserveRequestPayload, meta: SagaCommandMeta): Promise<StockReserveReplyPayload>;
  releaseStock(request: StockReleaseRequestPayload, meta: SagaCommandMeta): Promise<StockReleaseReplyPayload>;
  createDespatch(request: DespatchCreateRequestPayload, meta: SagaCommandMeta): Promise<DespatchCreateReplyPayload>;
  holdCredit(request: CreditHoldRequestPayload, meta: SagaCommandMeta): Promise<CreditHoldReplyPayload>;
  issueInvoice(request: InvoiceIssueRequestPayload, meta: SagaCommandMeta): Promise<InvoiceIssueReplyPayload>;
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
