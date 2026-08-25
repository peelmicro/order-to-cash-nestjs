// `RpcClient` (application/ports/rpc-client.port.ts) over core NATS
// request-reply — same shape
// apps/orders/src/infrastructure/messaging/nats-saga-commands.adapter.ts
// establishes (a narrow `NatsRequestClient` surface so unit tests need no
// broker, bare JSON via `JSONCodec`, `x-correlation-id`/`x-request-id`
// headers — Group A brief's own instruction to copy this file's shape
// exactly), generalised to ANY subject and — unlike that adapter — NEVER
// collapsing a business `RpcError` reply into a generic transport error:
// `RpcBusinessError` carries the ORIGINAL `code`/`details` through to
// `domain/problem/rpc-error-mapping.ts`.
import { ErrorCode, headers as natsHeaders, JSONCodec, type MsgHdrs, type NatsConnection } from 'nats';
import type { RpcError } from '@otc/contracts';
import { RpcBusinessError, RpcTimeoutError, RpcTransportError, type RpcCallMeta, type RpcClient } from '../../application/ports/rpc-client.port';

export interface NatsRequestMessage {
  readonly data: Uint8Array;
}

export interface NatsRequestClient {
  request(subject: string, data: Uint8Array, opts: { timeout: number; headers?: MsgHdrs }): Promise<NatsRequestMessage>;
}

function requestHeaders(meta: RpcCallMeta): MsgHdrs {
  const h = natsHeaders();
  h.set('x-correlation-id', meta.correlationId);
  h.set('x-request-id', meta.requestId);
  return h;
}

function isRpcErrorReply(body: unknown): body is RpcError {
  return typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string';
}

function isNoRespondersError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === ErrorCode.NoResponders;
}

function isTimeoutError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === ErrorCode.Timeout;
}

export class NatsRpcClientAdapter implements RpcClient {
  constructor(
    private readonly connection: NatsRequestClient | NatsConnection,
    private readonly defaultTimeoutMs: number,
  ) {}

  async call<TRequest, TReply>(subject: string, payload: TRequest, meta: RpcCallMeta, timeoutMs?: number): Promise<TReply> {
    const effectiveTimeoutMs = timeoutMs ?? this.defaultTimeoutMs;
    const requestCodec = JSONCodec<TRequest>();
    const replyCodec = JSONCodec<TReply | RpcError>();

    let reply: NatsRequestMessage;
    try {
      reply = await this.connection.request(subject, requestCodec.encode(payload), {
        timeout: effectiveTimeoutMs,
        headers: requestHeaders(meta),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new RpcTimeoutError(subject, effectiveTimeoutMs);
      }
      if (isNoRespondersError(error)) {
        throw new RpcTransportError(subject, 'no responder is subscribed to this subject');
      }
      throw new RpcTransportError(subject, error instanceof Error ? error.message : String(error));
    }

    let body: TReply | RpcError;
    try {
      body = replyCodec.decode(reply.data);
    } catch (error) {
      throw new RpcTransportError(subject, `reply payload was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (isRpcErrorReply(body)) {
      throw new RpcBusinessError(subject, body);
    }

    return body;
  }
}
