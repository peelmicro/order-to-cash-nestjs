/**
 * DO NOT EDIT — generated file.
 *
 * Produced by `pnpm contracts:generate` from
 * `specs/shared/asyncapi.yaml`.
 *
 * Regenerate with `pnpm --filter @otc/contracts run generate` (or the
 * root-level `pnpm contracts:generate`). Never hand-edit this file — a
 * manual change here will be silently discarded the next time the
 * generator runs, and `pnpm contracts:check` will fail loudly on the
 * drift in the meantime.
 */

/* eslint-disable */
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CancellationReason".
 */
export type CancellationReason = 'stock_rejected' | 'credit_rejected' | 'operator_cancelled';
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "ProductCode".
 */
export type ProductCode = string;
/**
 * An amount as a whole count of the currency's smallest denomination
 * (cents for EUR/GBP/USD). **Never** a decimal, float or major-unit value.
 * `€1,242.50` is `124250`. Used where the enclosing object already
 * declares its `currency`; where an amount travels alone, use `Money`.
 * The `.99` simulator predicate (R42) reads `totalAmount mod 100 = 99`,
 * which is only well defined on this representation.
 *
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "MinorUnits".
 */
export type MinorUnits = number;
/**
 * ISO 4217 alpha-3 code of a seeded currency.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CurrencyCode".
 */
export type CurrencyCode = string;
/**
 * Business identifier of a retailer (buyer) or company (supplier). Contexts reference each other by this, never by another context's internal id.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "PartyCode".
 */
export type PartyCode = string;
/**
 * Global Location Number — exactly 13 decimal digits whose final digit is
 * the GS1 mod-10 check digit over the preceding twelve (R4). The pattern
 * cannot express the check digit; it is a domain rule, validated on
 * construction.
 *
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "Gln".
 */
export type Gln = string;
/**
 * An opaque, globally unique identifier generated inside the domain, never by a store.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "UniqueId".
 */
export type UniqueId = string;
/**
 * A UTC instant, ISO-8601 on the wire, stamped through a clock port.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "Instant".
 */
export type Instant = string;
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CreditApprovedEvent".
 */
export type CreditApprovedEvent = Envelope & {
  eventType?: 'credit.approved.v1';
  payload?: CreditApprovedPayload;
};
/**
 * Human-readable, unique, immutable business reference of an order.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrderReference".
 */
export type OrderReference = string;
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CreditCode".
 */
export type CreditCode = string;
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CreditListRequestPayload".
 */
export type CreditListRequestPayload = PageRequest & {
  retailerCode?: PartyCode;
  companyCode?: PartyCode;
};
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CreditRejectedEvent".
 */
export type CreditRejectedEvent = Envelope & {
  eventType?: 'credit.rejected.v1';
  payload?: CreditRejectedPayload;
};
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CreditReleasedEvent".
 */
export type CreditReleasedEvent = Envelope & {
  eventType?: 'credit.released.v1';
  payload?: CreditReleasedPayload;
};
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "DespatchReference".
 */
export type DespatchReference = string;
/**
 * A strictly positive whole count of units. Zero, negative and fractional quantities do not exist in this model (R3).
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "Quantity".
 */
export type Quantity = number;
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "InvoiceIssuedEvent".
 */
export type InvoiceIssuedEvent = Envelope & {
  eventType?: 'invoice.issued.v1';
  payload?: InvoiceIssuedPayload;
};
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "InvoiceReference".
 */
export type InvoiceReference = string;
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "InvoiceStatus".
 */
export type InvoiceStatus = 'issued' | 'paid';
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "InvoiceListRequestPayload".
 */
export type InvoiceListRequestPayload = PageRequest & {
  status?: InvoiceStatus;
  retailerCode?: PartyCode;
  companyCode?: PartyCode;
  orderReference?: OrderReference;
  /**
   * Return only invoices issued at least this many minutes ago. This is how the demo payment robot selects invoices to pay "within terms".
   */
  issuedBeforeMinutes?: number;
};
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrderCancelledEvent".
 */
export type OrderCancelledEvent = Envelope & {
  eventType?: 'order.cancelled.v1';
  payload?: OrderCancelledPayload;
};
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrderCompletedEvent".
 */
export type OrderCompletedEvent = Envelope & {
  eventType?: 'order.completed.v1';
  payload?: OrderCompletedPayload;
};
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrderConfirmedEvent".
 */
export type OrderConfirmedEvent = Envelope & {
  eventType?: 'order.confirmed.v1';
  payload?: OrderConfirmedPayload;
};
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrderDespatchedEvent".
 */
export type OrderDespatchedEvent = Envelope & {
  eventType?: 'order.despatched.v1';
  payload?: OrderDespatchedPayload;
};
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrderPlacedEvent".
 */
export type OrderPlacedEvent = Envelope & {
  eventType?: 'order.placed.v1';
  payload?: OrderPlacedPayload;
};
/**
 * The `Order` state machine of `domain-model.md` §3.3, which is also the saga state. `completed` and `cancelled` are terminal.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrderStatus".
 */
export type OrderStatus =
  | 'placed'
  | 'stock_reserved'
  | 'credit_approved'
  | 'confirmed'
  | 'despatched'
  | 'invoiced'
  | 'paid'
  | 'completed'
  | 'cancelled';
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "PaymentReceivedEvent".
 */
export type PaymentReceivedEvent = Envelope & {
  eventType?: 'payment.received.v1';
  payload?: PaymentReceivedPayload;
};
/**
 * The idempotency key of the remittance intake (R48, invariant B10).
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "PaymentReference".
 */
export type PaymentReference = string;
/**
 * Provenance of a remittance. Carries no rule; it exists so a demo can tell an operator click from the external payment robot.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "PaymentSource".
 */
export type PaymentSource = 'operator' | 'robot' | 'test';
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "ReservationStatus".
 */
export type ReservationStatus = 'reserved' | 'released' | 'consumed';
/**
 * A non-negative whole count of units (on-hand, reserved, available).
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "UnitCount".
 */
export type UnitCount = number;
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockListRequestPayload".
 */
export type StockListRequestPayload = PageRequest & {
  companyCode?: PartyCode;
  productCode?: ProductCode;
  /**
   * When true, return only items whose available units are below `lowStockThreshold`. This is the query the demo replenishment workflow runs.
   */
  belowThreshold?: boolean;
};
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockRejectedEvent".
 */
export type StockRejectedEvent = Envelope & {
  eventType?: 'stock.rejected.v1';
  payload?: StockRejectedPayload;
};
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockReleasedEvent".
 */
export type StockReleasedEvent = Envelope & {
  eventType?: 'stock.released.v1';
  payload?: StockReleasedPayload;
};
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockReservedEvent".
 */
export type StockReservedEvent = Envelope & {
  eventType?: 'stock.reserved.v1';
  payload?: StockReservedPayload;
};

/**
 * Only the requested collections are present.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CatalogReferenceListReplyPayload".
 */
export interface CatalogReferenceListReplyPayload {
  products?: Product[];
  retailers?: Party[];
  companies?: Party[];
  currencies?: CurrencyView[];
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "Product".
 */
export interface Product {
  code: ProductCode;
  ean?: string;
  name: string;
  description?: string;
  price: MinorUnits;
  currency: CurrencyCode;
  enabled: boolean;
}
/**
 * A retailer or a company as the place-order form sees it.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "Party".
 */
export interface Party {
  code: PartyCode;
  name: string;
  country: string;
  vat?: string;
  gln: Gln;
  currency: CurrencyCode;
  enabled: boolean;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CurrencyView".
 */
export interface CurrencyView {
  code: CurrencyCode;
  isoNumber?: string;
  symbol?: string;
  /**
   * How many decimal places the currency has when **rendered**. It never changes the fact that amounts are transported as integer minor units.
   */
  decimalPoints: number;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CatalogReferenceListRequestPayload".
 */
export interface CatalogReferenceListRequestPayload {
  /**
   * Which reference collections to return. Omit for all of them.
   *
   * @minItems 1
   */
  kinds?: [
    'products' | 'retailers' | 'companies' | 'currencies',
    ...('products' | 'retailers' | 'companies' | 'currencies')[],
  ];
  includeDisabled?: boolean;
}
/**
 * One compensating action that ran before the cancellation, so the unwinding is auditable in causal order.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CompensationStep".
 */
export interface CompensationStep {
  step: 'stock_released' | 'credit_released';
  eventId?: UniqueId;
  eventType: string;
  occurredAt: Instant;
  summary?: string;
}
/**
 * The payload-independent contract carried by **every** fact, identical
 * across the trilogy (R11, R12). No field may be absent, null or empty.
 * Each of the thirteen fact schemas composes this with a `const`
 * `eventType` and its own `payload`.
 *
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "Envelope".
 */
export interface Envelope {
  /**
   * Globally unique. **The idempotency key of every consumer**, generated in the domain when the event is created, not when it is published.
   */
  eventId: UniqueId;
  /**
   * `<aggregate>.<fact>.v<n>`. The version suffix is part of the type: a breaking payload change is a new `v<n+1>` type carried alongside the old one.
   */
  eventType: string;
  /**
   * Identity of the aggregate that produced the fact — the order, the stock item, the credit line, the invoice.
   */
  aggregateId: UniqueId;
  /**
   * **Always the order id.** Partition key of the fact stream, log correlation id and read-model document key.
   */
  correlationId: UniqueId;
  /**
   * The `eventId` of the fact — or the id of the command — that caused this one, so the causal chain is reconstructible from the facts alone.
   */
  causationId: UniqueId;
  /**
   * When the fact **became true in the domain**, stamped by the aggregate — not when it was published or consumed. Timelines order by this, never by arrival (R50).
   */
  occurredAt: Instant;
  /**
   * The fact-specific body. All monetary fields are integer minor units.
   */
  payload: {};
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CreditApprovedPayload".
 */
export interface CreditApprovedPayload {
  orderReference: OrderReference;
  retailerCode: PartyCode;
  companyCode: PartyCode;
  creditCode: CreditCode;
  currency: CurrencyCode;
  heldAmount: MinorUnits;
  availableCreditAfter: MinorUnits;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CreditHoldReplyPayload".
 */
export interface CreditHoldReplyPayload {
  /**
   * `already_held` is the idempotent repeat (invariant B4) — the existing hold is returned and no second fact is emitted.
   */
  outcome: 'approved' | 'rejected' | 'already_held';
  orderReference: OrderReference;
  creditCode?: CreditCode;
  currency: CurrencyCode;
  heldAmount?: MinorUnits;
  availableCredit: MinorUnits;
  /**
   * Present when `outcome` is `rejected`, and identical to the `reason` of the emitted `credit.rejected.v1` (R44).
   */
  reason?: 'over_limit' | 'simulated_cents_rule' | 'simulated_failure_rate';
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CreditHoldRequestPayload".
 */
export interface CreditHoldRequestPayload {
  orderReference: OrderReference;
  retailerCode: PartyCode;
  companyCode: PartyCode;
  /**
   * The order's total amount. It travels alone here, so it is a `Money` object — integer minor units plus currency.
   */
  amount: Money;
}
/**
 * An amount that travels alone — integer minor units plus its currency.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "Money".
 */
export interface Money {
  amount: MinorUnits;
  currency: CurrencyCode;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CreditListReplyPayload".
 */
export interface CreditListReplyPayload {
  items: CreditView[];
  page: PageInfo;
}
/**
 * One credit line — limit, active holds, open invoice exposure and what is left.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CreditView".
 */
export interface CreditView {
  creditCode: CreditCode;
  retailerCode: PartyCode;
  companyCode: PartyCode;
  currency: CurrencyCode;
  creditLimit: MinorUnits;
  activeHolds: MinorUnits;
  openExposure: MinorUnits;
  /**
   * An amount as a whole count of the currency's smallest denomination
   * (cents for EUR/GBP/USD). **Never** a decimal, float or major-unit value.
   * `€1,242.50` is `124250`. Used where the enclosing object already
   * declares its `currency`; where an amount travels alone, use `Money`.
   * The `.99` simulator predicate (R42) reads `totalAmount mod 100 = 99`,
   * which is only well defined on this representation.
   *
   */
  availableCredit: number;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "PageInfo".
 */
export interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
}
/**
 * Common paging request fields for the read-only list subjects.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "PageRequest".
 */
export interface PageRequest {
  page?: number;
  pageSize?: number;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CreditRejectedPayload".
 */
export interface CreditRejectedPayload {
  orderReference: OrderReference;
  retailerCode: PartyCode;
  companyCode: PartyCode;
  creditCode?: CreditCode;
  currency: CurrencyCode;
  requestedAmount: MinorUnits;
  /**
   * An amount as a whole count of the currency's smallest denomination
   * (cents for EUR/GBP/USD). **Never** a decimal, float or major-unit value.
   * `€1,242.50` is `124250`. Used where the enclosing object already
   * declares its `currency`; where an amount travels alone, use `Money`.
   * The `.99` simulator predicate (R42) reads `totalAmount mod 100 = 99`,
   * which is only well defined on this representation.
   *
   */
  availableCredit: number;
  /**
   * `over_limit` is a genuine domain refusal. `simulated_cents_rule`
   * (R42) and `simulated_failure_rate` (R43) come from the credit-check
   * **simulator adapter** bound behind the credit port — a demo
   * determinism device, not a credit policy. Downstream behaviour is
   * identical in all three cases (R44).
   *
   */
  reason: 'over_limit' | 'simulated_cents_rule' | 'simulated_failure_rate';
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "CreditReleasedPayload".
 */
export interface CreditReleasedPayload {
  orderReference: OrderReference;
  retailerCode: PartyCode;
  companyCode: PartyCode;
  creditCode?: CreditCode;
  currency: CurrencyCode;
  releasedAmount: MinorUnits;
  availableCreditAfter: MinorUnits;
  reason: 'invoice_paid' | 'order_cancelled';
}
/**
 * Diagnostic headers of a dead-letter record. The payload stays the
 * unmodified original envelope so a redrive is a byte-for-byte republish;
 * everything about the failure lives here.
 *
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "DeadLetterHeaders".
 */
export interface DeadLetterHeaders {
  /**
   * Name of the consumer that exhausted its attempts — `orders.saga`, `projector` or `notifications`.
   */
  'x-failed-consumer': string;
  /**
   * How many processing attempts were made before giving up.
   */
  'x-attempts': number;
  /**
   * The error of the final attempt — class or code plus message. Stack traces belong in logs, not here.
   */
  'x-error': string;
  /**
   * The source topic, so a redrive knows where to republish.
   */
  'x-original-topic'?: string;
  'x-first-failed-at'?: Instant;
  'x-failed-at'?: Instant;
  traceparent?: string;
  'x-event-type'?: string;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "DespatchCreateReplyPayload".
 */
export interface DespatchCreateReplyPayload {
  orderReference: OrderReference;
  despatchReference: DespatchReference;
  despatchDate: Instant;
  /**
   * False on the idempotent repeat — the existing despatch advice is returned and no second fact is emitted (invariant F8).
   */
  created: boolean;
  lines?: DespatchLine[];
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "DespatchLine".
 */
export interface DespatchLine {
  productCode: ProductCode;
  units: Quantity;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "DespatchCreateRequestPayload".
 */
export interface DespatchCreateRequestPayload {
  orderReference: OrderReference;
}
/**
 * Transport headers carried by every fact. Trace context is mandatory so one distributed trace spans both brokers (R56, R57).
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "FactHeaders".
 */
export interface FactHeaders {
  /**
   * W3C trace context, injected on publish and extracted on consume.
   */
  traceparent: string;
  tracestate?: string;
  /**
   * Mirror of the envelope's `eventType`, so a consumer can filter without deserialising the payload (the cost of topic-per-service rather than topic-per-event).
   */
  'x-event-type': string;
  'content-type'?: string;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "InvoiceIssuedPayload".
 */
export interface InvoiceIssuedPayload {
  orderReference: OrderReference;
  invoiceReference: InvoiceReference;
  invoiceDate: Instant;
  retailerCode: PartyCode;
  companyCode: PartyCode;
  currency: CurrencyCode;
  /**
   * @minItems 1
   */
  lines: [InvoiceLine, ...InvoiceLine[]];
  amount: MinorUnits;
  discount: MinorUnits;
  totalAmount: MinorUnits;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "InvoiceLine".
 */
export interface InvoiceLine {
  productCode: ProductCode;
  units: Quantity;
  unitPrice: MinorUnits;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "InvoiceIssueReplyPayload".
 */
export interface InvoiceIssueReplyPayload {
  orderReference: OrderReference;
  invoiceId?: UniqueId;
  invoiceReference: InvoiceReference;
  invoiceDate: Instant;
  currency: CurrencyCode;
  totalAmount: MinorUnits;
  status: InvoiceStatus;
  /**
   * False on the idempotent repeat — the existing invoice is returned and no second fact is emitted (invariant B7).
   */
  created: boolean;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "InvoiceIssueRequestPayload".
 */
export interface InvoiceIssueRequestPayload {
  orderReference: OrderReference;
  retailerCode: PartyCode;
  companyCode: PartyCode;
  currency: CurrencyCode;
  /**
   * The despatched lines. The invoice mirrors them exactly — partial despatch and partial invoicing are out of scope (invariant F7).
   *
   * @minItems 1
   */
  lines: [InvoiceLine, ...InvoiceLine[]];
  discount?: MinorUnits;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "InvoiceListReplyPayload".
 */
export interface InvoiceListReplyPayload {
  items: InvoiceView[];
  page: PageInfo;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "InvoiceView".
 */
export interface InvoiceView {
  invoiceId: UniqueId;
  invoiceReference: InvoiceReference;
  invoiceDate: Instant;
  orderReference: OrderReference;
  retailerCode: PartyCode;
  companyCode: PartyCode;
  currency: CurrencyCode;
  amount: MinorUnits;
  discount: MinorUnits;
  totalAmount: MinorUnits;
  status: InvoiceStatus;
  /**
   * Set exactly when the status becomes `paid`, and null while `issued` (invariant B9).
   */
  paidAt?: Instant | null;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrderCancelledPayload".
 */
export interface OrderCancelledPayload {
  orderReference: OrderReference;
  retailerCode: PartyCode;
  companyCode: PartyCode;
  cancellationReason: CancellationReason;
  cancelledAt: Instant;
  /**
   * The compensating facts that ran before this cancellation, in causal order. Empty for `stock_rejected` — nothing was ever acquired (R26).
   */
  compensationSteps: CompensationStep[];
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrderCompletedPayload".
 */
export interface OrderCompletedPayload {
  orderReference: OrderReference;
  retailerCode: PartyCode;
  companyCode: PartyCode;
  currency: CurrencyCode;
  totalAmount: MinorUnits;
  completedAt: Instant;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrderConfirmedPayload".
 */
export interface OrderConfirmedPayload {
  orderReference: OrderReference;
  retailerCode: PartyCode;
  companyCode: PartyCode;
  currency: CurrencyCode;
  totalAmount: MinorUnits;
  confirmedAt: Instant;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrderDespatchedPayload".
 */
export interface OrderDespatchedPayload {
  orderReference: OrderReference;
  despatchReference: DespatchReference;
  despatchDate: Instant;
  companyCode: PartyCode;
  retailerCode: PartyCode;
  /**
   * @minItems 1
   */
  lines: [DespatchLine, ...DespatchLine[]];
}
/**
 * One line of an order. `unitPrice` and `lineDiscount` are minor units in the order's currency, snapshotted at order time.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrderLine".
 */
export interface OrderLine {
  productCode: ProductCode;
  description?: string;
  quantity: Quantity;
  unitPrice: MinorUnits;
  lineDiscount: MinorUnits;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrderPlacedPayload".
 */
export interface OrderPlacedPayload {
  orderReference: OrderReference;
  retailerCode: PartyCode;
  companyCode: PartyCode;
  buyerGln: Gln;
  supplierGln: Gln;
  currency: CurrencyCode;
  orderDate: Instant;
  /**
   * At least one line — an order with none cannot exist (invariant O1).
   *
   * @minItems 1
   */
  lines: [OrderLine, ...OrderLine[]];
  initialAmount: MinorUnits;
  initialDiscount: MinorUnits;
  totalAmount: MinorUnits;
  notes?: string;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrdersCancelReplyPayload".
 */
export interface OrdersCancelReplyPayload {
  orderId: UniqueId;
  orderReference: OrderReference;
  status: OrderStatus;
  cancellationReason?: CancellationReason;
  /**
   * The acquisitions that will be unwound, in reverse order of acquisition. The cancellation itself completes only when their facts arrive.
   */
  compensationPlanned: ('credit_release' | 'stock_release')[];
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrdersCancelRequestPayload".
 */
export interface OrdersCancelRequestPayload {
  orderId?: UniqueId;
  orderReference?: OrderReference;
  /**
   * Operator cancellation is the only reason a caller may request. `stock_rejected` and `credit_rejected` are decided by the saga, never asked for.
   */
  reason: 'operator_cancelled';
  note?: string;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrdersCreateReplyPayload".
 */
export interface OrdersCreateReplyPayload {
  /**
   * Also the saga `correlationId` of every fact this order will produce.
   */
  orderId: UniqueId;
  orderReference: OrderReference;
  status: 'placed';
  currency: CurrencyCode;
  initialAmount?: MinorUnits;
  initialDiscount?: MinorUnits;
  totalAmount: MinorUnits;
  orderDate: Instant;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "OrdersCreateRequestPayload".
 */
export interface OrdersCreateRequestPayload {
  /**
   * Optional client-supplied idempotency key. A repeat with the same value returns the original order instead of placing a second one.
   */
  requestId?: UniqueId;
  retailerCode: PartyCode;
  companyCode: PartyCode;
  currency: CurrencyCode;
  /**
   * @minItems 1
   */
  lines: [
    {
      productCode: ProductCode;
      quantity: Quantity;
      /**
       * An amount as a whole count of the currency's smallest denomination
       * (cents for EUR/GBP/USD). **Never** a decimal, float or major-unit value.
       * `€1,242.50` is `124250`. Used where the enclosing object already
       * declares its `currency`; where an amount travels alone, use `Money`.
       * The `.99` simulator predicate (R42) reads `totalAmount mod 100 = 99`,
       * which is only well defined on this representation.
       *
       */
      unitPrice?: number;
      lineDiscount?: MinorUnits;
    },
    ...{
      productCode: ProductCode;
      quantity: Quantity;
      /**
       * An amount as a whole count of the currency's smallest denomination
       * (cents for EUR/GBP/USD). **Never** a decimal, float or major-unit value.
       * `€1,242.50` is `124250`. Used where the enclosing object already
       * declares its `currency`; where an amount travels alone, use `Money`.
       * The `.99` simulator predicate (R42) reads `totalAmount mod 100 = 99`,
       * which is only well defined on this representation.
       *
       */
      unitPrice?: number;
      lineDiscount?: MinorUnits;
    }[],
  ];
  orderDiscount?: MinorUnits;
  notes?: string;
}
/**
 * A party as it appears in a read view — business code, display name and GLN. Named identically in `openapi.yaml`.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "PartyRef".
 */
export interface PartyRef {
  code: PartyCode;
  name?: string;
  gln: Gln;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "PaymentReceivedPayload".
 */
export interface PaymentReceivedPayload {
  orderReference: OrderReference;
  invoiceReference: InvoiceReference;
  paymentReference: PaymentReference;
  currency: CurrencyCode;
  /**
   * An amount as a whole count of the currency's smallest denomination
   * (cents for EUR/GBP/USD). **Never** a decimal, float or major-unit value.
   * `€1,242.50` is `124250`. Used where the enclosing object already
   * declares its `currency`; where an amount travels alone, use `Money`.
   * The `.99` simulator predicate (R42) reads `totalAmount mod 100 = 99`,
   * which is only well defined on this representation.
   *
   */
  amount: number;
  valueDate: Instant;
  source: PaymentSource;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "PaymentRegisterReplyPayload".
 */
export interface PaymentRegisterReplyPayload {
  /**
   * `duplicate` is the idempotent replay of an already-recorded `paymentReference`, carrying the **original** outcome (R48). A mismatched amount or currency is not a duplicate — it is an error reply (R49).
   */
  outcome: 'accepted' | 'duplicate';
  paymentReference: PaymentReference;
  invoiceReference: InvoiceReference;
  orderReference?: OrderReference;
  invoiceStatus: InvoiceStatus;
  paidAt?: Instant;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "PaymentRegisterRequestPayload".
 */
export interface PaymentRegisterRequestPayload {
  invoiceId?: UniqueId;
  invoiceReference?: InvoiceReference;
  /**
   * **The idempotency key.** A repeat returns the original outcome and emits no second fact (R48).
   */
  paymentReference: PaymentReference;
  /**
   * Must equal the invoice `totalAmount` and currency exactly. Partial payment is out of scope (invariant B10).
   */
  amount: Money;
  valueDate: Instant;
  source: PaymentSource;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "ReservationRef".
 */
export interface ReservationRef {
  reservationId: UniqueId;
  productCode: ProductCode;
  units: Quantity;
}
/**
 * The error reply of every subject. `code` is stable and machine-readable;
 * `message` is for humans and is never parsed.
 *
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "RpcError".
 */
export interface RpcError {
  /**
   * `TIMEOUT` is produced **by the caller**, not by a responder, when no
   * reply arrives within the deadline — it exists here so callers can
   * log and count timeouts in the same shape as real error replies.
   *
   */
  code:
    | 'VALIDATION_FAILED'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'PRECONDITION_FAILED'
    | 'ORDER_NOT_CANCELLABLE'
    | 'STOCK_UNAVAILABLE'
    | 'INVOICE_NOT_PAYABLE'
    | 'PAYMENT_MISMATCH'
    | 'DOMAIN_ERROR'
    | 'INTERNAL_ERROR'
    | 'UNAVAILABLE'
    | 'TIMEOUT';
  message: string;
  /**
   * Structured context — offending field, shortages, expected versus observed status. Shape depends on `code`.
   */
  details?: {};
  correlationId?: UniqueId;
  occurredAt?: Instant;
}
/**
 * Headers carried by every request and every reply on the RPC transport.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "RpcHeaders".
 */
export interface RpcHeaders {
  /**
   * W3C trace context, injected on request and extracted by the responder so the trace continues across both brokers (R57).
   */
  traceparent: string;
  tracestate?: string;
  /**
   * The order id when the request concerns a known order; otherwise the gateway request id. Present on every structured log line produced while handling the request (R58).
   */
  'x-correlation-id'?: UniqueId;
  /**
   * Identity of this request attempt. A retry after a timeout reuses the same value, which is what lets a responder recognise a duplicate.
   */
  'x-request-id'?: UniqueId;
  /**
   * The caller's remaining budget in milliseconds. A responder that cannot answer within it should not start.
   */
  'x-deadline-ms'?: number;
}
/**
 * **A timeout is not a message.** It is the caller observing that no reply
 * arrived within `x-deadline-ms`, and it is a legitimate, handled answer
 * on this transport — which is precisely why the RPC transport needs no
 * durability (`saga.md` §1).
 *
 * Handling is normative (R29): the orchestrator retries with backoff up to
 * the configured maximum **while leaving the order status unchanged**, so
 * the saga is always resumable from a legal state. Because every command
 * is idempotent by (`orderReference`, operation), a retry that duplicates
 * an effect the responder already applied returns the existing outcome
 * instead of repeating it. On exhausting the attempts, the **triggering
 * fact** is routed to the dead-letter topic and a saga-failure entry is
 * written to the order timeline.
 *
 * This schema is documentation of that contract; nothing serialises it.
 *
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "RpcTimeout".
 */
export interface RpcTimeout {
  code: 'TIMEOUT';
  /**
   * The subject that did not answer.
   */
  subject: string;
  attempt: number;
  maxAttempts?: number;
  deadlineMs?: number;
  orderReference?: OrderReference;
}
/**
 * One line that could not be satisfied, with what was asked for and what was free.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "Shortage".
 */
export interface Shortage {
  productCode: ProductCode;
  requested: Quantity;
  available: UnitCount;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockCheckReplyPayload".
 */
export interface StockCheckReplyPayload {
  /**
   * True only when every line is satisfiable **at the moment of the read**. It is not a promise, and it is not a reservation.
   */
  available: boolean;
  lines: {
    productCode: ProductCode;
    requested: Quantity;
    available: UnitCount;
    sufficient: boolean;
  }[];
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockCheckRequestPayload".
 */
export interface StockCheckRequestPayload {
  companyCode: PartyCode;
  /**
   * @minItems 1
   */
  lines: [
    {
      productCode: ProductCode;
      quantity: Quantity;
    },
    ...{
      productCode: ProductCode;
      quantity: Quantity;
    }[],
  ];
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockListReplyPayload".
 */
export interface StockListReplyPayload {
  items: StockView[];
  page: PageInfo;
}
/**
 * On-hand and reserved units for one (companyCode, productCode) pair.
 *
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockView".
 */
export interface StockView {
  companyCode: PartyCode;
  productCode: ProductCode;
  units: UnitCount;
  reservedUnits: UnitCount;
  /**
   * A non-negative whole count of units (on-hand, reserved, available).
   */
  availableUnits: number;
  lowStockThreshold: UnitCount;
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockRejectedPayload".
 */
export interface StockRejectedPayload {
  orderReference: OrderReference;
  companyCode: PartyCode;
  retailerCode?: PartyCode;
  /**
   * @minItems 1
   */
  shortages: [Shortage, ...Shortage[]];
  reason: 'insufficient_stock' | 'unknown_product';
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockReleasedPayload".
 */
export interface StockReleasedPayload {
  orderReference: OrderReference;
  companyCode: PartyCode;
  retailerCode?: PartyCode;
  /**
   * @minItems 1
   */
  released: [ReservationRef, ...ReservationRef[]];
  /**
   * Why the reservation was returned. Compensation after a credit refusal, or an operator cancellation while stock was held.
   */
  reason: 'credit_rejected' | 'order_cancelled';
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockReleaseReplyPayload".
 */
export interface StockReleaseReplyPayload {
  /**
   * `already_released` is a **success no-op**: no counter changed and no second fact was emitted (invariant F5, R34).
   */
  outcome: 'released' | 'already_released';
  orderReference: OrderReference;
  released?: ReservationRef[];
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockReleaseRequestPayload".
 */
export interface StockReleaseRequestPayload {
  orderReference: OrderReference;
  reason: 'credit_rejected' | 'order_cancelled';
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockReplenishReplyPayload".
 */
export interface StockReplenishReplyPayload {
  /**
   * The affected stock items after replenishment.
   */
  items: StockView[];
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockReplenishRequestPayload".
 */
export interface StockReplenishRequestPayload {
  companyCode: PartyCode;
  /**
   * @minItems 1
   */
  lines: [
    {
      productCode: ProductCode;
      /**
       * A strictly positive whole count of units. Zero, negative and fractional quantities do not exist in this model (R3).
       */
      units: number;
    },
    ...{
      productCode: ProductCode;
      /**
       * A strictly positive whole count of units. Zero, negative and fractional quantities do not exist in this model (R3).
       */
      units: number;
    }[],
  ];
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockReservedPayload".
 */
export interface StockReservedPayload {
  orderReference: OrderReference;
  companyCode: PartyCode;
  retailerCode?: PartyCode;
  /**
   * One reservation per order line — reservation is all-or-nothing (invariant F3).
   *
   * @minItems 1
   */
  reservations: [ReservationRef, ...ReservationRef[]];
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockReserveReplyPayload".
 */
export interface StockReserveReplyPayload {
  /**
   * `already_reserved` is the idempotent repeat — the existing reservations are returned and no second `stock.reserved.v1` is emitted.
   */
  outcome: 'accepted' | 'rejected' | 'already_reserved';
  orderReference: OrderReference;
  /**
   * Present when `outcome` is `accepted` or `already_reserved`.
   */
  reservations?: ReservationRef[];
  /**
   * Present when `outcome` is `rejected`. Nothing was reserved (invariant F3).
   */
  shortages?: Shortage[];
}
/**
 * This interface was referenced by `AsyncApiComponents`'s JSON-Schema
 * via the `definition` "StockReserveRequestPayload".
 */
export interface StockReserveRequestPayload {
  orderReference: OrderReference;
  retailerCode: PartyCode;
  companyCode: PartyCode;
  /**
   * @minItems 1
   */
  lines: [
    {
      productCode: ProductCode;
      units: Quantity;
    },
    ...{
      productCode: ProductCode;
      units: Quantity;
    }[],
  ];
}
