// The application's requirement of the outside world — design.md §8. The
// port interface lands in this feature; the Drizzle adapter that satisfies
// it lands in feature 15 (`orders_acceptance`), where `save` can first be
// written honestly (one transaction across the order row, its lines and the
// outbox records — feature 14 territory). `Symbol` is used as the injection
// token so this file needs no `@nestjs/common` import; the Nest provider
// binding is written in feature 15.
//
// Provisional in one respect, recorded as expected rather than as drift:
// feature 14 will add a transactional-context parameter to `save`
// (`save(order, tx)` or a unit-of-work wrapper).
import type { OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { Order } from '../../domain/order.js';

export const ORDER_REPOSITORY = Symbol('OrderRepository');

export interface OrderRepository {
  findById(id: UniqueId): Promise<Order | null>;
  findByReference(reference: OrderNumber): Promise<Order | null>;
  save(order: Order): Promise<void>;
}
