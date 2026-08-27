import type { OrderSummaryPage } from '#shared/types/gateway';
import { gatewayFetch } from '../../utils/gateway';

/** `GET /orders` — proxied straight through to the Gateway's read-model list query (R54). Query params (status[], retailerCode, companyCode, orderReference, page, pageSize) pass through untouched. */
export default defineEventHandler(async (event): Promise<OrderSummaryPage> => {
  return gatewayFetch<OrderSummaryPage>(event, '/orders', { query: getQuery(event) });
});
