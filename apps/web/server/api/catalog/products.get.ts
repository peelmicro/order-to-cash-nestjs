import type { Product } from '#shared/types/gateway';
import { gatewayFetch } from '../../utils/gateway';

export default defineEventHandler(async (event): Promise<{ items: Product[] }> => {
  return gatewayFetch<{ items: Product[] }>(event, '/catalog/products', { query: getQuery(event) });
});
