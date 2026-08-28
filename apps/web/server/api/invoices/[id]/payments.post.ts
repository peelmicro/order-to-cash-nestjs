import type { RegisterPaymentRequest, RegisterPaymentResponse } from '#shared/types/gateway';
import { gatewayFetchWithStatus } from '../../../utils/gateway';

/**
 * `POST /invoices/{id}/payments` — registers a remittance (R47). This is the
 * only way an invoice becomes `paid`; the saga then carries the order
 * `invoiced → paid → completed` asynchronously (openapi.yaml).
 *
 * `paymentReference` in the body **is** the idempotency key (invariant B10,
 * R48) — a replay of the same reference against the same invoice/amount
 * answers `200`/`outcome: duplicate` instead of `201`/`outcome: accepted`,
 * both genuine 2xx success as far as `$fetch` is concerned, so — exactly
 * like `GET /orders/{id}`'s `202` handling
 * (`server/api/orders/[id].get.ts`) — the real upstream status is captured
 * via `gatewayFetchWithStatus` and forwarded verbatim rather than always
 * answering `201`. A genuine rejection (`409`/`422`, R49) still throws and
 * is forwarded as an RFC 9457 problem document by `gatewayFetchWithStatus`'s
 * own error path.
 */
export default defineEventHandler(async (event): Promise<RegisterPaymentResponse> => {
  const invoiceId = getRouterParam(event, 'id');
  const body = await readBody<RegisterPaymentRequest>(event);

  const { status, data } = await gatewayFetchWithStatus<RegisterPaymentResponse>(event, `/invoices/${invoiceId}/payments`, {
    method: 'POST',
    body,
  });

  setResponseStatus(event, status);
  return data;
});
