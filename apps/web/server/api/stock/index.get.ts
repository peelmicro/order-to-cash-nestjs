import type { StockPage } from '#shared/types/gateway';
import { gatewayFetch } from '../../utils/gateway';

/**
 * `GET /stock` — a LIVE read of Fulfillment's own write model (openapi.yaml:
 * "stock is not part of an order's timeline"), never the Mongo read model —
 * there is no projection lag to surface for this endpoint, unlike
 * `GET /orders/{id}`. Query params (companyCode, productCode,
 * belowThreshold, page, pageSize) pass through untouched, matching
 * `server/api/orders/index.get.ts`'s pattern. On an RPC timeout or a down
 * responder, the Gateway answers `503 UpstreamUnavailable`; `gatewayFetch`
 * forwards that real status/body rather than swallowing it into a 500.
 */
export default defineEventHandler(async (event): Promise<StockPage> => {
  return gatewayFetch<StockPage>(event, '/stock', { query: getQuery(event) });
});
