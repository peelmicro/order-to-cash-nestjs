// Local convenience aliases onto `GatewayComponents['schemas'][...]`
// (`@otc/contracts`) for the openapi.yaml schemas this service needs beyond
// the ones the package's own barrel already aliases (`PlaceOrderRequest`,
// `OrderSummary`, ...). Kept in ONE file, in `application/` (not `domain/`
// — it imports from `@otc/contracts`, a workspace package, which the
// domain-purity ESLint rule does not special-case) so every command/query
// handler reaches for the same names instead of re-deriving
// `GatewayComponents['schemas'][...]` inline at each call site.
import type { GatewayComponents } from '@otc/contracts';

export type CurrentUser = GatewayComponents['schemas']['CurrentUser'];
export type LoginResponse = GatewayComponents['schemas']['LoginResponse'];
export type CancelOrderResponse = GatewayComponents['schemas']['CancelOrderResponse'];
export type OrderSummaryPage = GatewayComponents['schemas']['OrderSummaryPage'];
export type StockItem = GatewayComponents['schemas']['StockItem'];
export type StockPage = GatewayComponents['schemas']['StockPage'];
export type ReplenishStockResponse = GatewayComponents['schemas']['ReplenishStockResponse'];
export type Invoice = GatewayComponents['schemas']['Invoice'];
export type InvoicePage = GatewayComponents['schemas']['InvoicePage'];
export type Credit = GatewayComponents['schemas']['Credit'];
export type CreditPage = GatewayComponents['schemas']['CreditPage'];
export type Product = GatewayComponents['schemas']['Product'];
export type Party = GatewayComponents['schemas']['Party'];
export type HealthResponse = GatewayComponents['schemas']['HealthResponse'];
export type OrderStreamUpdate = GatewayComponents['schemas']['OrderStreamUpdate'];
export type TimelineStreamEntry = GatewayComponents['schemas']['TimelineStreamEntry'];
export type StreamReady = GatewayComponents['schemas']['StreamReady'];
export type StreamPing = GatewayComponents['schemas']['StreamPing'];
export type StockUnavailableProblem = GatewayComponents['schemas']['StockUnavailableProblem'];
export type ValidationProblem = GatewayComponents['schemas']['ValidationProblem'];
export type Problem = GatewayComponents['schemas']['Problem'];
