// The `SagaCommandsPort` adapter — one NATS core request-reply call per
// saga command, reusing `nats-stock-availability.adapter.ts`'s shape
// verbatim (design.md §6.1): the shared outbound `NatsConnection`, per-call
// `{ timeout }`, the same narrow `NatsRequestClient` surface so unit tests
// need no broker, the same error taxonomy. Subjects are the AsyncAPI
// addresses, guarded by `nats-saga-commands.adapter.spec.ts`'s
// read-the-spec-as-text assertion (design.md §6.1).
import { ErrorCode, headers as natsHeaders, JSONCodec, type MsgHdrs, type NatsConnection } from 'nats';
import type {
  CreditHoldReplyPayload,
  CreditHoldRequestPayload,
  CreditReleaseReplyPayload,
  CreditReleaseRequestPayload,
  DespatchCreateReplyPayload,
  DespatchCreateRequestPayload,
  InvoiceIssueReplyPayload,
  InvoiceIssueRequestPayload,
  RpcError,
  StockReleaseReplyPayload,
  StockReleaseRequestPayload,
  StockReserveReplyPayload,
  StockReserveRequestPayload,
} from '@otc/contracts';
import {
  SagaCommandBusinessRejectionError,
  SagaCommandTimeoutError,
  SagaCommandTransportError,
  type SagaCommandMeta,
  type SagaCommandsPort,
} from '../../application/ports/saga-commands.port';
import { injectNatsTraceContext } from '../observability/trace-context';

export const STOCK_RESERVE_SUBJECT = 'fulfillment.stock.reserve';
export const STOCK_RELEASE_SUBJECT = 'fulfillment.stock.release';
export const DESPATCH_CREATE_SUBJECT = 'fulfillment.despatch.create';
export const CREDIT_HOLD_SUBJECT = 'billing.credit.hold';
export const INVOICE_ISSUE_SUBJECT = 'billing.invoice.issue';
/** Feature 41's follow-up pass — closing the `credit_approved`/`confirmed` cancel gap. */
export const CREDIT_RELEASE_SUBJECT = 'billing.credit.release';

export interface NatsRequestMessage {
  readonly data: Uint8Array;
}

export interface NatsRequestClient {
  request(subject: string, data: Uint8Array, opts: { timeout: number; headers?: MsgHdrs }): Promise<NatsRequestMessage>;
}

/**
 * `x-correlation-id`/`x-request-id` as `nats` `MsgHdrs` (FS2, asyncapi.yaml
 * `RpcHeaders`), plus `traceparent`/`tracestate` (OR4, R57, design.md
 * §4.3) injected from the active OTel trace context — the responder in
 * Fulfillment/Billing is out of this pass's bounded scope (neither service
 * is touched), so THEIR extraction side is not wired up yet; this half of
 * the hop (inject on publish) is still real and independently correct.
 */
function requestHeaders(meta: SagaCommandMeta): MsgHdrs {
  const h = natsHeaders();
  h.set('x-correlation-id', meta.correlationId.value);
  h.set('x-request-id', meta.requestId.value);
  injectNatsTraceContext(h);
  return h;
}

function isRpcErrorReply(body: unknown): body is RpcError {
  return typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string';
}

/**
 * Feature 42: `RpcError.code` (`@otc/contracts`) is a closed union that
 * splits into terminal-business codes — a definitive "no" from the
 * responder's own domain, which retrying can never turn into a "yes" —
 * and transient/infra codes, which a later attempt genuinely might
 * resolve. `TIMEOUT` never reaches here (the caller's own timeout,
 * thrown before any reply body exists); it is listed on the transient
 * side of the exhaustive switch purely so the switch stays exhaustive
 * against the full `RpcError['code']` union.
 */
function isTerminalRpcErrorCode(code: RpcError['code']): boolean {
  switch (code) {
    case 'VALIDATION_FAILED':
    case 'NOT_FOUND':
    case 'CONFLICT':
    case 'PRECONDITION_FAILED':
    case 'ORDER_NOT_CANCELLABLE':
    case 'STOCK_UNAVAILABLE':
    case 'INVOICE_NOT_PAYABLE':
    case 'PAYMENT_MISMATCH':
    case 'DOMAIN_ERROR':
      return true;
    case 'TIMEOUT':
    case 'UNAVAILABLE':
    case 'INTERNAL_ERROR':
      return false;
    default: {
      const exhaustive: never = code;
      throw new Error(`nats-saga-commands.adapter: unmapped RpcError code "${String(exhaustive)}"`);
    }
  }
}

function isNoRespondersError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === ErrorCode.NoResponders
  );
}

function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === ErrorCode.Timeout
  );
}

export class NatsSagaCommandsAdapter implements SagaCommandsPort {
  constructor(
    private readonly connection: NatsRequestClient | NatsConnection,
    private readonly timeoutMs: number,
  ) {}

  reserveStock(request: StockReserveRequestPayload, meta: SagaCommandMeta): Promise<StockReserveReplyPayload> {
    return this.call(STOCK_RESERVE_SUBJECT, request, meta);
  }

  releaseStock(request: StockReleaseRequestPayload, meta: SagaCommandMeta): Promise<StockReleaseReplyPayload> {
    return this.call(STOCK_RELEASE_SUBJECT, request, meta);
  }

  createDespatch(request: DespatchCreateRequestPayload, meta: SagaCommandMeta): Promise<DespatchCreateReplyPayload> {
    return this.call(DESPATCH_CREATE_SUBJECT, request, meta);
  }

  holdCredit(request: CreditHoldRequestPayload, meta: SagaCommandMeta): Promise<CreditHoldReplyPayload> {
    return this.call(CREDIT_HOLD_SUBJECT, request, meta);
  }

  issueInvoice(request: InvoiceIssueRequestPayload, meta: SagaCommandMeta): Promise<InvoiceIssueReplyPayload> {
    return this.call(INVOICE_ISSUE_SUBJECT, request, meta);
  }

  releaseCredit(request: CreditReleaseRequestPayload, meta: SagaCommandMeta): Promise<CreditReleaseReplyPayload> {
    return this.call(CREDIT_RELEASE_SUBJECT, request, meta);
  }

  private async call<TRequest, TReply>(subject: string, request: TRequest, meta: SagaCommandMeta): Promise<TReply> {
    const requestCodec = JSONCodec<TRequest>();
    const replyCodec = JSONCodec<TReply | RpcError>();

    let reply: NatsRequestMessage;
    try {
      reply = await this.connection.request(subject, requestCodec.encode(request), {
        timeout: this.timeoutMs,
        headers: requestHeaders(meta),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new SagaCommandTimeoutError(subject, this.timeoutMs);
      }
      if (isNoRespondersError(error)) {
        throw new SagaCommandTransportError(subject, 'no responder is subscribed to this subject');
      }
      throw new SagaCommandTransportError(subject, error instanceof Error ? error.message : String(error));
    }

    let body: TReply | RpcError;
    try {
      body = replyCodec.decode(reply.data);
    } catch (error) {
      throw new SagaCommandTransportError(
        subject,
        `reply payload was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (isRpcErrorReply(body)) {
      if (isTerminalRpcErrorCode(body.code)) {
        throw new SagaCommandBusinessRejectionError(subject, body.code, body.message);
      }
      throw new SagaCommandTransportError(subject, `responder returned ${body.code}: ${body.message}`);
    }

    return body;
  }
}
