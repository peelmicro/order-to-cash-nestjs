/**
 * @otc/contracts — the only place any service, the gateway, the web app or a
 * test may get a wire type from. Every type re-exported here is generated,
 * never hand-transcribed (`pnpm contracts:generate` /
 * `progress/impl_contracts_package.md`).
 *
 * Deep imports from `./generated/*` are intentionally not part of the public
 * surface: import from `@otc/contracts` (the package name), never from
 * `@otc/contracts/dist/generated/...`.
 */

// ─────────────────────── AsyncAPI — the messaging contract ───────────────────────
// Shared kernel primitives (identical across both specs by design — see
// asyncapi.yaml's info.description and openapi.yaml's info.description).
export type {
  UniqueId,
  Instant,
  CurrencyCode,
  MinorUnits,
  Money,
  Gln,
  Quantity,
  UnitCount,
  PartyCode,
  ProductCode,
  OrderReference,
  DespatchReference,
  InvoiceReference,
  CreditCode,
  PaymentReference,
  PartyRef,
  OrderStatus,
  CancellationReason,
  InvoiceStatus,
  ReservationStatus,
  PaymentSource,
  OrderLine,
  ReservationRef,
  Shortage,
  DespatchLine,
  InvoiceLine,
  CompensationStep,
  PageRequest,
  PageInfo,
  StockView,
  CreditView,
  InvoiceView,
  Product,
  Party,
  CurrencyView,
} from './generated/asyncapi.types.js';

// The fact envelope (R11) and the two header shapes every fact / dead letter
// carries.
export type { Envelope, FactHeaders, DeadLetterHeaders } from './generated/asyncapi.types.js';

// The thirteen domain facts — payload alone (for constructing one inside a
// domain aggregate) and the full envelope+payload event shape (for what
// travels on the wire and what a consumer receives).
export type {
  OrderPlacedPayload,
  OrderPlacedEvent,
  StockReservedPayload,
  StockReservedEvent,
  StockRejectedPayload,
  StockRejectedEvent,
  StockReleasedPayload,
  StockReleasedEvent,
  CreditApprovedPayload,
  CreditApprovedEvent,
  CreditRejectedPayload,
  CreditRejectedEvent,
  CreditReleasedPayload,
  CreditReleasedEvent,
  OrderConfirmedPayload,
  OrderConfirmedEvent,
  OrderDespatchedPayload,
  OrderDespatchedEvent,
  InvoiceIssuedPayload,
  InvoiceIssuedEvent,
  PaymentReceivedPayload,
  PaymentReceivedEvent,
  OrderCompletedPayload,
  OrderCompletedEvent,
  OrderCancelledPayload,
  OrderCancelledEvent,
} from './generated/asyncapi.types.js';

// RPC common structures (R29, R57, R58) and the request/reply payload pair
// for every one of the fourteen NATS request-reply subjects.
export type {
  RpcHeaders,
  RpcError,
  RpcTimeout,
  OrdersCreateRequestPayload,
  OrdersCreateReplyPayload,
  OrdersCancelRequestPayload,
  OrdersCancelReplyPayload,
  StockCheckRequestPayload,
  StockCheckReplyPayload,
  StockReserveRequestPayload,
  StockReserveReplyPayload,
  StockReleaseRequestPayload,
  StockReleaseReplyPayload,
  StockListRequestPayload,
  StockListReplyPayload,
  StockReplenishRequestPayload,
  StockReplenishReplyPayload,
  DespatchCreateRequestPayload,
  DespatchCreateReplyPayload,
  CreditHoldRequestPayload,
  CreditHoldReplyPayload,
  CreditListRequestPayload,
  CreditListReplyPayload,
  InvoiceIssueRequestPayload,
  InvoiceIssueReplyPayload,
  InvoiceListRequestPayload,
  InvoiceListReplyPayload,
  PaymentRegisterRequestPayload,
  PaymentRegisterReplyPayload,
  CatalogReferenceListRequestPayload,
  CatalogReferenceListReplyPayload,
} from './generated/asyncapi.types.js';

// ─────────────────────── OpenAPI — the Gateway REST contract ───────────────────────
// The three root shapes `openapi-typescript` emits. Every request/response
// body schema is reachable from `GatewayComponents['schemas'][...]`; every
// operation's parameters/request/response are reachable from
// `GatewayOperations[...]` or by path from `GatewayPaths[...]`.
export type {
  paths as GatewayPaths,
  components as GatewayComponents,
  operations as GatewayOperations,
} from './generated/openapi.types.js';

import type { components as GatewayComponentsInternal } from './generated/openapi.types.js';

/** Convenience aliases for the schemas a Gateway client reaches for most
 * often. Not exhaustive by design — every other schema is one property
 * access away on `GatewayComponents['schemas']`, which is the deliberate
 * "narrow surface, full reach" shape of this barrel. */
export type PlaceOrderRequest = GatewayComponentsInternal['schemas']['PlaceOrderRequest'];
export type PlaceOrderResponse = GatewayComponentsInternal['schemas']['PlaceOrderResponse'];
export type OrderSummary = GatewayComponentsInternal['schemas']['OrderSummary'];
export type OrderDetail = GatewayComponentsInternal['schemas']['OrderDetail'];
export type ProjectionPending = GatewayComponentsInternal['schemas']['ProjectionPending'];
export type Problem = GatewayComponentsInternal['schemas']['Problem'];
export type OrderStreamUpdate = GatewayComponentsInternal['schemas']['OrderStreamUpdate'];
export type TimelineStreamEntry = GatewayComponentsInternal['schemas']['TimelineStreamEntry'];
export type RegisterPaymentRequest = GatewayComponentsInternal['schemas']['RegisterPaymentRequest'];
export type RegisterPaymentResponse =
  GatewayComponentsInternal['schemas']['RegisterPaymentResponse'];
