// The real `IssuedOrderWindow` (domain/orders/issued-order-window.ts) is
// pure and fast enough to use directly in unit tests — no fake needed,
// just a convenience constructor with a fixed clock and generous
// defaults so call sites do not repeat the same three arguments.
import { IssuedOrderWindow } from '../domain/orders/issued-order-window';

export function newIssuedOrderWindow(now: Date = new Date('2026-08-18T10:00:00.000Z')): IssuedOrderWindow {
  return new IssuedOrderWindow({ now: () => now }, 300_000, 10_000);
}
