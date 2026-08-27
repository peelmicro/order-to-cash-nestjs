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

/** The shape `server/api/auth/session.get.ts` and `server/api/auth/login.post.ts` return to the browser — the operator's identity, never the token (F14). */
export interface SessionInfo {
  authenticated: boolean;
  username?: string;
  displayName?: string;
  roles?: string[];
}
