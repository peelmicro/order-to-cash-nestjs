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
  SagaCommandTimeoutError,
  SagaCommandTransportError,
  type SagaCommandMeta,
  type SagaCommandsPort,
} from '../../application/ports/saga-commands.port';

export const STOCK_RESERVE_SUBJECT = 'fulfillment.stock.reserve';
export const STOCK_RELEASE_SUBJECT = 'fulfillment.stock.release';
export const DESPATCH_CREATE_SUBJECT = 'fulfillment.despatch.create';
export const CREDIT_HOLD_SUBJECT = 'billing.credit.hold';
export const INVOICE_ISSUE_SUBJECT = 'billing.invoice.issue';

export interface NatsRequestMessage {
  readonly data: Uint8Array;
}

export interface NatsRequestClient {
  request(subject: string, data: Uint8Array, opts: { timeout: number; headers?: MsgHdrs }): Promise<NatsRequestMessage>;
}

/** `x-correlation-id`/`x-request-id` as `nats` `MsgHdrs` (FS2, asyncapi.yaml `RpcHeaders`). */
function requestHeaders(meta: SagaCommandMeta): MsgHdrs {
  const h = natsHeaders();
  h.set('x-correlation-id', meta.correlationId.value);
  h.set('x-request-id', meta.requestId.value);
  return h;
}

function isRpcErrorReply(body: unknown): body is RpcError {
  return typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string';
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
      throw new SagaCommandTransportError(subject, `responder returned ${body.code}: ${body.message}`);
    }

    return body;
  }
}
