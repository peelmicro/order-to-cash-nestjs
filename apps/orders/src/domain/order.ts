// The `Order` aggregate root — domain-model.md §3, design.md §4. A pure
// function of its inputs: it never reads a clock, never generates a
// timestamp itself and never talks to a port. Everything it needs is passed
// in through `TransitionContext` (design.md §4.6).
import {
  AggregateRoot,
  UniqueId,
  type DomainEventEnvelope,
  type GLN,
  type Money,
  type OrderNumber,
  type Quantity,
} from '@otc/shared-kernel';
import type { CompensationStep } from '@otc/contracts';
import { CANCELLATION_REASONS, isCancellationReason, type CancellationReason } from './order-cancellation-reason.js';
import {
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
import { orderCancelledEvent, orderCompletedEvent, orderConfirmedEvent, orderPlacedEvent } from './order-events.js';
import { OrderLine } from './order-line.js';
import type { OrderSnapshot } from './order-snapshot.js';
import { isOrderStatus, ORDER_STATUSES, type OrderStatus } from './order-status.js';
import { computeOrderTotals } from './order-totals.js';
import { findTransition, type OrderTransition } from './order-transitions.js';

/** Time and causation in, nothing pulled — design.md §4.6. */
export interface TransitionContext {
  /** The UTC instant the fact became true (envelope contract). */
  readonly occurredAt: Date;
  /** The `eventId` of the causing fact, or the id of the causing command (R12). */
  readonly causationId: UniqueId;
}

export interface PlaceOrderLineInput {
  readonly productCode: string;
  readonly description: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly lineDiscount: Money;
}

export interface PlaceOrderInput {
  readonly id: UniqueId;
  readonly orderReference: OrderNumber;
  readonly orderDate: Date;
  readonly buyer: { readonly gln: GLN; readonly code: string };
  readonly supplier: { readonly gln: GLN; readonly code: string };
  readonly currency: string;
  readonly lines: readonly PlaceOrderLineInput[];
  readonly notes?: string;
}

/** A frozen, non-reachable-for-mutation view of one line (OA5). */
export interface OrderLineView {
  readonly id: UniqueId;
  readonly productCode: string;
  readonly description: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly lineDiscount: Money;
}

interface OrderProps {
  readonly id: UniqueId;
  readonly orderReference: OrderNumber;
  readonly orderDate: Date;
  readonly buyerGln: GLN;
  readonly retailerCode: string;
  readonly supplierGln: GLN;
  readonly companyCode: string;
  readonly currency: string;
  readonly lines: readonly OrderLine[];
  readonly initialAmount: Money;
  readonly initialDiscount: Money;
  readonly totalAmount: Money;
  readonly status: OrderStatus;
  readonly cancellationReason?: CancellationReason;
  readonly notes?: string;
}

/** `Order.addLine`/`removeLine`/`changeLineQuantity` are legal only while status is one of these three — O4/R7. */
const LINES_MUTABLE_IN = new Set<OrderStatus>(['placed', 'stock_reserved', 'credit_approved']);

interface TransitionOptions {
  /** Extra props to assign atomically with `status` — e.g. `cancellationReason` on `cancel`. */
  readonly propsPatch?: Partial<OrderProps>;
  /** Builds the fact to append, called only when Table T-1 names one for this edge. */
  readonly buildEvent?: (order: Order, ctx: TransitionContext) => DomainEventEnvelope;
}

export class Order extends AggregateRoot<Order> {
  private constructor(private props: OrderProps) {
    super(props.id);
  }

  // ── Construction — the only two paths (design.md §4.2) ──────────────────

  /**
   * The only way a *new* order comes into being. Enforces every creation
   * invariant **before** anything is assigned: at least one line (O1/R5),
   * every line's currency equal to the order currency (O2/OA1), totals
   * derived and non-negative (O3/R6), then status `placed` and exactly one
   * `order.placed.v1` (Table T-1 row 1, OA2).
   */
  static place(input: PlaceOrderInput, ctx: TransitionContext): Order {
    if (input.lines.length === 0) {
      throw new EmptyOrderError(input.id);
    }

    for (const line of input.lines) {
      Order.assertLineCurrency(input.currency, line, input.id);
    }

    const lines = input.lines.map((line) =>
      OrderLine.create({
        id: UniqueId.generate(),
        productCode: line.productCode,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineDiscount: line.lineDiscount,
      }),
    );

    const totals = computeOrderTotalsFor(input.id, input.currency, lines);

    const props: OrderProps = {
      id: input.id,
      orderReference: input.orderReference,
      orderDate: input.orderDate,
      buyerGln: input.buyer.gln,
      retailerCode: input.buyer.code,
      supplierGln: input.supplier.gln,
      companyCode: input.supplier.code,
      currency: input.currency,
      lines,
      initialAmount: totals.initialAmount,
      initialDiscount: totals.initialDiscount,
      totalAmount: totals.totalAmount,
      status: 'placed',
      notes: input.notes,
    };

    // Table T-1 row 1 ("(none) -> placed", emits order.placed.v1) governs
    // this construction even though `place` does not run through the
    // generic `transitionTo` funnel below — there is no *existing*
    // aggregate to transition from.
    const order = new Order(props);
    order.addDomainEvent(orderPlacedEvent(order, ctx));
    return order;
  }

  /**
   * Rebuilds an order that already exists. Emits **no** event (OA3), takes
   * `status` from the snapshot (validated against the closed set), derives
   * totals fresh from `lines` — `OrderSnapshot` carries no totals fields at
   * all — and requires a cancellation reason iff `status === 'cancelled'`.
   */
  static reconstitute(snapshot: OrderSnapshot): Order {
    if (!isOrderStatus(snapshot.status)) {
      throw new InvalidOrderSnapshotError(
        `status "${String(snapshot.status)}" is not one of ${ORDER_STATUSES.join(', ')}`,
        snapshot.id,
      );
    }
    if (snapshot.lines.length === 0) {
      throw new EmptyOrderError(snapshot.id);
    }
    const isCancelled = snapshot.status === 'cancelled';
    if (isCancelled && !isCancellationReason(snapshot.cancellationReason)) {
      throw new InvalidOrderSnapshotError(
        `status is cancelled but cancellationReason is not one of ${CANCELLATION_REASONS.join(', ')}`,
        snapshot.id,
      );
    }
    if (!isCancelled && snapshot.cancellationReason !== undefined) {
      throw new InvalidOrderSnapshotError(
        `cancellationReason "${snapshot.cancellationReason}" is set but status is "${snapshot.status}", not cancelled`,
        snapshot.id,
      );
    }

    const lines = snapshot.lines.map((line) =>
      OrderLine.create({
        id: line.id,
        productCode: line.productCode,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineDiscount: line.lineDiscount,
      }),
    );

    const totals = computeOrderTotalsFor(snapshot.id, snapshot.currency, lines);

    const props: OrderProps = {
      id: snapshot.id,
      orderReference: snapshot.orderReference,
      orderDate: snapshot.orderDate,
      buyerGln: snapshot.buyerGln,
      retailerCode: snapshot.retailerCode,
      supplierGln: snapshot.supplierGln,
      companyCode: snapshot.companyCode,
      currency: snapshot.currency,
      lines,
      initialAmount: totals.initialAmount,
      initialDiscount: totals.initialDiscount,
      totalAmount: totals.totalAmount,
      status: snapshot.status,
      cancellationReason: snapshot.cancellationReason,
      notes: snapshot.notes,
    };

    return new Order(props);
  }

  // ── Read-only accessors ──────────────────────────────────────────────────

  get orderReference(): OrderNumber {
    return this.props.orderReference;
  }

  get orderDate(): Date {
    return this.props.orderDate;
  }

  get buyerGln(): GLN {
    return this.props.buyerGln;
  }

  get retailerCode(): string {
    return this.props.retailerCode;
  }

  get supplierGln(): GLN {
    return this.props.supplierGln;
  }

  get companyCode(): string {
    return this.props.companyCode;
  }

  get currency(): string {
    return this.props.currency;
  }

  get status(): OrderStatus {
    return this.props.status;
  }

  /** Frozen copies (OA5) — mutating the returned array or any element changes neither the order's lines nor its totals. */
  get lines(): readonly OrderLineView[] {
    return Object.freeze(
      this.props.lines.map((line) =>
        Object.freeze<OrderLineView>({
          id: line.id,
          productCode: line.productCode,
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineDiscount: line.lineDiscount,
        }),
      ),
    );
  }

  get initialAmount(): Money {
    return this.props.initialAmount;
  }

  get initialDiscount(): Money {
    return this.props.initialDiscount;
  }

  get totalAmount(): Money {
    return this.props.totalAmount;
  }

  get cancellationReason(): CancellationReason | undefined {
    return this.props.cancellationReason;
  }

  get notes(): string | undefined {
    return this.props.notes;
  }

  // ── Line mutators — validate-then-commit (design.md §4.4) ───────────────

  addLine(input: PlaceOrderLineInput): void {
    this.assertLinesMutable();
    Order.assertLineCurrency(this.props.currency, input, this.id);

    const newLine = OrderLine.create({
      id: UniqueId.generate(),
      productCode: input.productCode,
      description: input.description,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      lineDiscount: input.lineDiscount,
    });
    const candidateLines = [...this.props.lines, newLine];
    const totals = computeOrderTotalsFor(this.id, this.props.currency, candidateLines);

    this.props = { ...this.props, lines: candidateLines, ...totals };
  }

  removeLine(lineId: UniqueId): void {
    this.assertLinesMutable();
    const exists = this.props.lines.some((line) => line.id.equals(lineId));
    if (!exists) {
      throw new UnknownOrderLineError(this.id, lineId);
    }
    const candidateLines = this.props.lines.filter((line) => !line.id.equals(lineId));
    if (candidateLines.length === 0) {
      throw new EmptyOrderError(this.id);
    }
    const totals = computeOrderTotalsFor(this.id, this.props.currency, candidateLines);

    this.props = { ...this.props, lines: candidateLines, ...totals };
  }

  changeLineQuantity(lineId: UniqueId, quantity: Quantity): void {
    this.assertLinesMutable();
    const target = this.props.lines.find((line) => line.id.equals(lineId));
    if (!target) {
      throw new UnknownOrderLineError(this.id, lineId);
    }
    const candidateLines = this.props.lines.map((line) =>
      line.id.equals(lineId) ? line.withQuantity(quantity) : line,
    );
    const totals = computeOrderTotalsFor(this.id, this.props.currency, candidateLines);

    this.props = { ...this.props, lines: candidateLines, ...totals };
  }

  // ── Command methods — one per saga step (design.md §4.5) ─────────────────

  markStockReserved(ctx: TransitionContext): void {
    this.transitionTo('stock_reserved', ctx);
  }

  approveCredit(ctx: TransitionContext): void {
    this.transitionTo('credit_approved', ctx);
  }

  confirm(ctx: TransitionContext): void {
    this.transitionTo('confirmed', ctx, { buildEvent: orderConfirmedEvent });
  }

  markDespatched(ctx: TransitionContext): void {
    this.transitionTo('despatched', ctx);
  }

  markInvoiced(ctx: TransitionContext): void {
    this.transitionTo('invoiced', ctx);
  }

  markPaid(ctx: TransitionContext): void {
    this.transitionTo('paid', ctx);
  }

  complete(ctx: TransitionContext): void {
    this.transitionTo('completed', ctx, { buildEvent: orderCompletedEvent });
  }

  /**
   * Cancels the order. A reason is required and must be a member of the
   * closed set (O6/R10); the reason must additionally be one Table T-1
   * pairs with the current status (OA4): `stock_rejected` only from
   * `placed`, `credit_rejected` only from `stock_reserved`,
   * `operator_cancelled` from any of the four cancellable statuses.
   * `compensationSteps` is supplied by the caller — the aggregate never
   * observes `stock.released.v1` itself (design.md §4.5).
   */
  cancel(
    reason: CancellationReason,
    ctx: TransitionContext,
    compensationSteps: readonly CompensationStep[] = [],
  ): void {
    if (reason === undefined || reason === null) {
      throw new CancellationReasonRequiredError(this.id);
    }
    if (!isCancellationReason(reason)) {
      throw new InvalidCancellationReasonError(this.id, String(reason));
    }

    const currentStatus = this.props.status;
    const transition = findTransition(currentStatus, 'cancelled');
    if (!transition) {
      throw new OrderTransitionNotAllowedError(this.id, currentStatus, 'cancelled');
    }
    if (reason === 'stock_rejected' && currentStatus !== 'placed') {
      throw new CancellationReasonNotApplicableError(this.id, currentStatus, reason);
    }
    if (reason === 'credit_rejected' && currentStatus !== 'stock_reserved') {
      throw new CancellationReasonNotApplicableError(this.id, currentStatus, reason);
    }

    this.transitionTo('cancelled', ctx, {
      propsPatch: { cancellationReason: reason },
      buildEvent: (order, transitionCtx) => orderCancelledEvent(order, reason, compensationSteps, transitionCtx),
    });
  }

  // ── The transition funnel every command method above uses ───────────────

  private transitionTo(to: OrderStatus, ctx: TransitionContext, options: TransitionOptions = {}): void {
    const transition: OrderTransition | undefined = findTransition(this.props.status, to);
    if (!transition) {
      throw new OrderTransitionNotAllowedError(this.id, this.props.status, to);
    }

    this.props = { ...this.props, status: to, ...(options.propsPatch ?? {}) };

    if (transition.emits && options.buildEvent) {
      this.addDomainEvent(options.buildEvent(this, ctx));
    }
  }

  private assertLinesMutable(): void {
    if (!LINES_MUTABLE_IN.has(this.props.status)) {
      throw new OrderLinesFrozenError(this.id, this.props.status);
    }
  }

  /**
   * Rejects at the aggregate boundary (OA1) rather than letting the
   * kernel's `CurrencyMismatchError` escape from `Money` arithmetic inside
   * `computeOrderTotals`.
   */
  private static assertLineCurrency(
    orderCurrency: string,
    line: { readonly unitPrice: Money; readonly lineDiscount: Money },
    orderId?: UniqueId,
    lineId?: UniqueId,
  ): void {
    if (line.unitPrice.currency !== orderCurrency) {
      throw new OrderLineCurrencyMismatchError(orderCurrency, line.unitPrice.currency, orderId, lineId);
    }
    if (line.lineDiscount.currency !== orderCurrency) {
      throw new OrderLineCurrencyMismatchError(orderCurrency, line.lineDiscount.currency, orderId, lineId);
    }
  }
}

function computeOrderTotalsFor(
  orderId: UniqueId,
  currency: string,
  lines: readonly OrderLine[],
): { initialAmount: Money; initialDiscount: Money; totalAmount: Money } {
  try {
    return computeOrderTotals(currency, lines);
  } catch (error) {
    if (error instanceof NegativeOrderTotalError) {
      throw new NegativeOrderTotalError(error.totalAmount, orderId);
    }
    throw error;
  }
}
