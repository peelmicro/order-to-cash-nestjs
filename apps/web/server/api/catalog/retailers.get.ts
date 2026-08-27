import type { Party } from '#shared/types/gateway';
import { gatewayFetch } from '../../utils/gateway';

export default defineEventHandler(async (event): Promise<{ items: Party[] }> => {
  return gatewayFetch<{ items: Party[] }>(event, '/catalog/retailers', { query: getQuery(event) });
});
