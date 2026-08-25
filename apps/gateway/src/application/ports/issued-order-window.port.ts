// DI token for the singleton `IssuedOrderWindow` (domain/orders/issued-order-window.ts)
// shared between `PlaceOrderHandler` (which records) and `GetOrderHandler`
// (which reads) — a plain value provider, not a "port with an adapter":
// there is exactly one process-wide instance and nothing to swap it for.
import type { IssuedOrderWindow } from '../../domain/orders/issued-order-window';

export const ISSUED_ORDER_WINDOW = Symbol('IssuedOrderWindow');
export type { IssuedOrderWindow };
