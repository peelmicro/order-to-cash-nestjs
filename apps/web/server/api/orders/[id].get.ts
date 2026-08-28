import type { OrderDetail, ProjectionPending } from '#shared/types/gateway';
import { gatewayFetchWithStatus } from '../../utils/gateway';

/**
 * `GET /orders/{id}` (R54) — the read-model document and its full timeline.
 * `202`/`ProjectionPending` (R55) is forwarded with its real status code,
 * not swallowed into a `200`: the order was accepted but has not been
 * projected yet, and the client renders that honestly (a waiting state, not
 * a spinner pretending to load, not a 404) rather than being told
 * everything is fine.
 */
export default defineEventHandler(async (event): Promise<OrderDetail | ProjectionPending> => {
  const id = getRouterParam(event, 'id');
  const { status, data } = await gatewayFetchWithStatus<OrderDetail | ProjectionPending>(event, `/orders/${id}`);
  setResponseStatus(event, status);
  return data;
});
