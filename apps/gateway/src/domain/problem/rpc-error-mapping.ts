// The ONE place `RpcError.code` (asyncapi.yaml `components.schemas.RpcError`)
// is translated into an HTTP status and the `Problem.code` (openapi.yaml
// `components.schemas.Problem`) the gateway answers with. Pure — no
// NestJS, no `nats`, no I/O — so it is unit-testable on its own and so the
// ESLint domain-purity guard (CLAUDE.md non-negotiable) leaves it alone.
//
// Every RPC responder in this system maps ITS OWN domain errors down to
// the six-ish generic `RpcError.code`s (VALIDATION_FAILED, NOT_FOUND,
// CONFLICT, PRECONDITION_FAILED, DOMAIN_ERROR, ...) and keeps the specific
// vocabulary (`INVOICE_ALREADY_PAID`, `PAYMENT_REFERENCE_CONFLICT`, ...) in
// `details.code` (see e.g. apps/billing/src/presentation/rpc-error-mapper.ts).
// `openapi.yaml`'s `Problem.code` examples name the SPECIFIC vocabulary
// (`ORDER_NOT_CANCELLABLE`, `INVOICE_ALREADY_PAID`, `PAYMENT_MISMATCH`,
// `PAYMENT_REFERENCE_REUSED`, `STOCK_UNAVAILABLE`) — this file is the
// gateway's one translation step back from "generic RPC vocabulary plus an
// opaque details.code" to "the openapi contract's own stable code", so a
// client of THIS gateway never has to know which upstream service raised
// the refusal or how that service's own mapper happened to label it.
export interface RpcErrorLike {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown> | undefined;
}

export interface ClassifiedRpcError {
  readonly status: number;
  readonly code: string;
  readonly title: string;
}

/**
 * `details.code` values that name a MORE SPECIFIC business outcome than
 * their enclosing generic `RpcError.code` — each entry overrides both the
 * `status` its generic code would otherwise imply and the `Problem.code`
 * the caller sees.
 */
const DETAIL_CODE_OVERRIDES: Record<string, ClassifiedRpcError> = {
  INVOICE_ALREADY_PAID: { status: 409, code: 'INVOICE_ALREADY_PAID', title: 'Invoice already paid' },
  INVOICE_PAYMENT_AMOUNT_MISMATCH: { status: 422, code: 'PAYMENT_MISMATCH', title: 'Payment amount does not match the invoice total' },
  INVOICE_PAYMENT_CURRENCY_MISMATCH: { status: 422, code: 'PAYMENT_MISMATCH', title: 'Payment currency does not match the invoice total' },
  PAYMENT_REFERENCE_CONFLICT: { status: 409, code: 'PAYMENT_REFERENCE_REUSED', title: 'Payment reference reused for a different invoice or amount' },
  ORDER_NOT_CANCELLABLE: { status: 409, code: 'ORDER_NOT_CANCELLABLE', title: 'Order is not cancellable' },
};

/** Generic `RpcError.code` → HTTP status + fallback `Problem.code`/`title`, used whenever `details.code` names nothing more specific. */
const GENERIC_CODE_CLASSIFICATION: Record<string, ClassifiedRpcError> = {
  VALIDATION_FAILED: { status: 400, code: 'VALIDATION_FAILED', title: 'The request was malformed or failed validation' },
  NOT_FOUND: { status: 404, code: 'NOT_FOUND', title: 'No such resource' },
  CONFLICT: { status: 409, code: 'CONFLICT', title: 'The request conflicts with the current state' },
  PRECONDITION_FAILED: { status: 409, code: 'PRECONDITION_FAILED', title: 'A precondition of this operation was not met' },
  ORDER_NOT_CANCELLABLE: { status: 409, code: 'ORDER_NOT_CANCELLABLE', title: 'Order is not cancellable' },
  STOCK_UNAVAILABLE: { status: 409, code: 'STOCK_UNAVAILABLE', title: 'Insufficient stock at acceptance' },
  INVOICE_NOT_PAYABLE: { status: 409, code: 'INVOICE_NOT_PAYABLE', title: 'Invoice is not payable' },
  PAYMENT_MISMATCH: { status: 422, code: 'PAYMENT_MISMATCH', title: 'Payment amount or currency does not match the invoice' },
  DOMAIN_ERROR: { status: 422, code: 'DOMAIN_ERROR', title: 'A domain rule refused the request' },
  INTERNAL_ERROR: { status: 500, code: 'INTERNAL_ERROR', title: 'An unexpected error occurred' },
  UNAVAILABLE: { status: 503, code: 'UPSTREAM_UNAVAILABLE', title: 'The owning context is unreachable' },
  TIMEOUT: { status: 503, code: 'UPSTREAM_TIMEOUT', title: 'The owning context did not answer within the deadline' },
};

const DEFAULT_CLASSIFICATION: ClassifiedRpcError = {
  status: 500,
  code: 'INTERNAL_ERROR',
  title: 'An unexpected error occurred',
};

export function classifyRpcError(error: RpcErrorLike): ClassifiedRpcError {
  const detailCode = typeof error.details?.code === 'string' ? error.details.code : undefined;
  if (detailCode && DETAIL_CODE_OVERRIDES[detailCode]) {
    return DETAIL_CODE_OVERRIDES[detailCode];
  }
  return GENERIC_CODE_CLASSIFICATION[error.code] ?? DEFAULT_CLASSIFICATION;
}
