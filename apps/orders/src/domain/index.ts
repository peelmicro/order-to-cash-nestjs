// The deliberate public surface of the Orders domain — design.md §2. The
// aggregate, its child entity, the closed types, the state machine table,
// the totals function, the event builders, the domain errors and the
// snapshot/input shapes. Everything else in this directory (e.g. the
// `LINES_MUTABLE_IN` set, the private `transitionTo` funnel) stays internal
// to `order.ts` and is reached only through the methods exported here.
export {
  Order,
  type OrderLineView,
  type PlaceOrderInput,
  type PlaceOrderLineInput,
  type TransitionContext,
} from './order.js';

export { OrderLine, type OrderLineProps } from './order-line.js';

export { ORDER_STATUSES, isOrderStatus, type OrderStatus } from './order-status.js';

export {
  CANCELLATION_REASONS,
  isCancellationReason,
  type CancellationReason,
} from './order-cancellation-reason.js';

export {
  ORDER_TRANSITIONS,
  findTransition,
  type OrderTransition,
  type OrdersFactType,
} from './order-transitions.js';

export { computeOrderTotals, type OrderTotals } from './order-totals.js';

export {
  orderCancelledEvent,
  orderCompletedEvent,
  orderConfirmedEvent,
  orderPlacedEvent,
} from './order-events.js';

export {
  CancellationReasonNotApplicableError,
  CancellationReasonRequiredError,
  EmptyOrderError,
  InvalidCancellationReasonError,
  InvalidOrderSnapshotError,
  NegativeOrderTotalError,
  OrderLineCurrencyMismatchError,
  OrderLinesFrozenError,
  OrderTransitionNotAllowedError,
  UnknownOrderLineError,
} from './order-errors.js';

export type { OrderLineSnapshot, OrderSnapshot } from './order-snapshot.js';
