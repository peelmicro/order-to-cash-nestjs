import type { InvoicePage } from '#shared/types/gateway';
import { gatewayFetch } from '../../utils/gateway';

/**
 * `GET /invoices` — proxied straight through to the Gateway's
 * `billing.invoice.list` read query. Query params (status, retailerCode,
 * companyCode, orderReference, issuedBeforeMinutes, page, pageSize) pass
 * through untouched, matching `server/api/orders/index.get.ts`'s pattern.
 */
export default defineEventHandler(async (event): Promise<InvoicePage> => {
  return gatewayFetch<InvoicePage>(event, '/invoices', { query: getQuery(event) });
});
