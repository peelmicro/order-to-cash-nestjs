import type { ReplenishStockRequest, ReplenishStockResponse } from '#shared/types/gateway';
import { gatewayFetch } from '../../utils/gateway';

/**
 * `POST /stock/replenish` — adds `units` (a DELTA, never a target level) to
 * on-hand stock for one or more `(companyCode, productCode)` lines.
 * Reservations/`reservedUnits` are untouched (invariant F1 cannot be broken
 * by a replenishment) and, per openapi.yaml, **no fact is emitted** — a
 * top-up is an operational act outside any order's saga. Deliberately not
 * idempotent: repeating this call adds again, matching the spec's own
 * "pretending otherwise would silently drop legitimate repeats".
 */
export default defineEventHandler(async (event): Promise<ReplenishStockResponse> => {
  const body = await readBody<ReplenishStockRequest>(event);
  return gatewayFetch<ReplenishStockResponse>(event, '/stock/replenish', { method: 'POST', body });
});
