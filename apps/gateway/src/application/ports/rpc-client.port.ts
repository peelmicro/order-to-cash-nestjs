// The ONE port every command/query handler that talks to Orders,
// Fulfillment or Billing uses (Group A/C/B of the brief). One call = one
// NATS core request-reply round trip. The adapter
// (infrastructure/messaging/nats-rpc-client.adapter.ts) is the ONLY place
// that imports `nats` for its value — this port is what keeps every
// application-layer command/query handler free of that import, same
// "port declared in application/, adapter implements it in
// infrastructure/" shape every other service in this repo uses for its
// outbound calls (e.g. apps/orders' `SagaCommandsPort` /
// `NatsSagaCommandsAdapter`).
import type { RpcError } from '@otc/contracts';

export const RPC_CLIENT = Symbol('RpcClient');

export interface RpcCallMeta {
  /** The order id when the request concerns a known order; otherwise the gateway's own request id (asyncapi.yaml `rpcCorrelationId`). */
  readonly correlationId: string;
  /** Identity of this specific attempt — a retry after a timeout reuses the SAME value (asyncapi.yaml `RpcHeaders.x-request-id`). */
  readonly requestId: string;
}

export interface RpcClient {
  /**
   * Resolves with the decoded success payload. Rejects with
   * `RpcTimeoutError`, `RpcTransportError` or `RpcBusinessError` — never
   * resolves with an `RpcError`-shaped body; that discrimination happens
   * once, here, so every caller can simply `await`.
   */
  call<TRequest, TReply>(subject: string, payload: TRequest, meta: RpcCallMeta, timeoutMs?: number): Promise<TReply>;
}

export abstract class RpcCallError extends Error {
  abstract readonly code: string;
}

/** No reply arrived within the deadline (asyncapi.yaml `RpcTimeout` — "a legitimate, handled answer", never a message). */
export class RpcTimeoutError extends RpcCallError {
  readonly code = 'TIMEOUT';

  constructor(
    readonly subject: string,
    readonly timeoutMs: number,
  ) {
    super(`RPC call to "${subject}" timed out after ${timeoutMs}ms`);
  }
}

/** No responder is subscribed, or the transport itself failed — the command was NOT applied (openapi.yaml `UpstreamUnavailable`). */
export class RpcTransportError extends RpcCallError {
  readonly code = 'UNAVAILABLE';

  constructor(
    readonly subject: string,
    reason: string,
  ) {
    super(`RPC call to "${subject}" failed: ${reason}`);
  }
}

/** The responder answered with the `RpcError` reply shape — a business refusal, not a transport failure. Carries the ORIGINAL `RpcError` untouched so `domain/problem/rpc-error-mapping.ts` sees the real `code`/`details`. */
export class RpcBusinessError extends RpcCallError {
  constructor(
    readonly subject: string,
    readonly rpcError: RpcError,
  ) {
    super(rpcError.message);
  }

  get code(): string {
    return this.rpcError.code;
  }

  get details(): Record<string, unknown> | undefined {
    return this.rpcError.details as Record<string, unknown> | undefined;
  }
}
