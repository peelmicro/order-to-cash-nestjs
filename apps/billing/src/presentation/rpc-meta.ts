// Hoisted out of `credit.controller.ts` (`billing_invoicing` design.md §4.1)
// so `invoice.controller.ts` can share it — one function with two callers
// inside one service, not the cross-service duplication the parity guards
// exist for. `BC1`/`BI2`: `x-correlation-id`/`x-request-id` parsed with
// `UniqueId.from`; `null` when either is absent or malformed.
import type { NatsContext } from '@nestjs/microservices';
import { UniqueId } from '@otc/shared-kernel';
import type { RpcError } from '@otc/contracts';

export interface RpcMeta {
  readonly correlationId: UniqueId;
  readonly requestId: UniqueId;
}

export function parseRpcMeta(ctx: NatsContext): RpcMeta | null {
  const headers = ctx.getHeaders() as { get(key: string): string } | undefined;
  if (!headers) {
    return null;
  }
  const correlationRaw = headers.get('x-correlation-id');
  const requestRaw = headers.get('x-request-id');
  if (!correlationRaw || !requestRaw) {
    return null;
  }
  try {
    return { correlationId: UniqueId.from(correlationRaw), requestId: UniqueId.from(requestRaw) };
  } catch {
    return null;
  }
}

export function missingHeadersRpcError(): RpcError {
  return {
    code: 'VALIDATION_FAILED',
    message: 'x-correlation-id and x-request-id are required headers and must be valid UniqueIds (BC1)',
    occurredAt: new Date().toISOString(),
  };
}
