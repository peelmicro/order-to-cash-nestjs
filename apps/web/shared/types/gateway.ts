/**
 * Convenience aliases onto `@otc/contracts`' generated OpenAPI types — every
 * request/response shape this app uses comes from here, never hand-written
 * (per the feature brief). `@otc/contracts` itself only aliases a handful of
 * schemas at its top level, so the rest are reached through
 * `GatewayComponents['schemas'][...]`, which is still the generated type,
 * just one property access away.
 *
 * Lives under `shared/` (Nuxt 4's auto-imported directory reachable from
 * both `app/` and `server/`) so client composables and Nitro server routes
 * import the identical types for the identical wire shapes.
 */
import type { GatewayComponents, PlaceOrderRequest, PlaceOrderResponse, OrderSummary, Problem } from '@otc/contracts';

export type { PlaceOrderRequest, PlaceOrderResponse, OrderSummary, Problem };

export type LoginRequest = GatewayComponents['schemas']['LoginRequest'];
export type LoginResponse = GatewayComponents['schemas']['LoginResponse'];
export type CurrentUser = GatewayComponents['schemas']['CurrentUser'];
export type PlaceOrderLine = GatewayComponents['schemas']['PlaceOrderLine'];
export type OrderSummaryPage = GatewayComponents['schemas']['OrderSummaryPage'];
export type OrderStatus = GatewayComponents['schemas']['OrderStatus'];
export type PageInfo = GatewayComponents['schemas']['PageInfo'];
export type Party = GatewayComponents['schemas']['Party'];
export type Product = GatewayComponents['schemas']['Product'];
export type ValidationProblem = GatewayComponents['schemas']['ValidationProblem'];
export type StockUnavailableProblem = GatewayComponents['schemas']['StockUnavailableProblem'];

// ── Order detail + live SSE timeline (feature 29 pass 3) ──────────────────
export type OrderDetail = GatewayComponents['schemas']['OrderDetail'];
export type TimelineEntry = GatewayComponents['schemas']['TimelineEntry'];
export type ProjectionPending = GatewayComponents['schemas']['ProjectionPending'];
export type OrderStreamUpdate = GatewayComponents['schemas']['OrderStreamUpdate'];
export type TimelineStreamEntry = GatewayComponents['schemas']['TimelineStreamEntry'];
export type StreamReady = GatewayComponents['schemas']['StreamReady'];
export type StreamPing = GatewayComponents['schemas']['StreamPing'];
export type OrderReferences = GatewayComponents['schemas']['OrderReferences'];
export type OrderTotals = GatewayComponents['schemas']['OrderTotals'];
export type PartyRef = GatewayComponents['schemas']['PartyRef'];

// ── Billing: invoices, payments, credit limits (feature 29 pass 6) ────────
export type Invoice = GatewayComponents['schemas']['Invoice'];
export type InvoicePage = GatewayComponents['schemas']['InvoicePage'];
export type InvoiceStatus = GatewayComponents['schemas']['InvoiceStatus'];
export type RegisterPaymentRequest = GatewayComponents['schemas']['RegisterPaymentRequest'];
export type RegisterPaymentResponse = GatewayComponents['schemas']['RegisterPaymentResponse'];
export type PaymentSource = GatewayComponents['schemas']['PaymentSource'];
export type Credit = GatewayComponents['schemas']['Credit'];
export type CreditPage = GatewayComponents['schemas']['CreditPage'];

// ── Stock: on-hand/reserved/available, replenishment (feature 29 pass 7) ──
export type StockItem = GatewayComponents['schemas']['StockItem'];
export type StockPage = GatewayComponents['schemas']['StockPage'];
export type ReplenishStockRequest = GatewayComponents['schemas']['ReplenishStockRequest'];
export type ReplenishStockResponse = GatewayComponents['schemas']['ReplenishStockResponse'];

/** The shape `server/api/auth/session.get.ts` and `server/api/auth/login.post.ts` return to the browser — the operator's identity, never the token (F14). */
export interface SessionInfo {
  authenticated: boolean;
  username?: string;
  displayName?: string;
  roles?: string[];
}
