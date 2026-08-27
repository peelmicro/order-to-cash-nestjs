import type { PlaceOrderRequest, PlaceOrderResponse } from '#shared/types/gateway';
import { gatewayFetch } from '../../utils/gateway';

/**
 * `POST /orders` — places an order. `201` means accepted, not that the saga
 * finished (openapi.yaml's own words) — the order list page's own
 * refetch/polling is what shows it progress, per this pass's scope.
 */
export default defineEventHandler(async (event): Promise<PlaceOrderResponse> => {
  const body = await readBody<PlaceOrderRequest>(event);
  const idempotencyKey = getHeader(event, 'idempotency-key');

  const result = await gatewayFetch<PlaceOrderResponse>(event, '/orders', {
    method: 'POST',
    body,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
  });

  setResponseStatus(event, 201);
  return result;
});
