import type { CreditPage } from '#shared/types/gateway';
import { gatewayFetch } from '../../utils/gateway';

/**
 * `GET /credits` — credit limits and current exposure per retailer
 * (`billing.credit.list`). `availableCredit = creditLimit − activeHolds −
 * openExposure` (invariant B1) — this is the view that makes an over-limit
 * rejection legible, as opposed to the simulator's `.99` affordance alone
 * (openapi.yaml).
 */
export default defineEventHandler(async (event): Promise<CreditPage> => {
  return gatewayFetch<CreditPage>(event, '/credits', { query: getQuery(event) });
});
