import type { Problem } from '#shared/types/gateway';

/**
 * Extracts the Gateway's own RFC 9457 problem document from a thrown
 * `$fetch`/`ofetch` `FetchError`, once it has passed through this app's own
 * Nitro server proxy.
 *
 * **Why this exists — a real, previously-undetected defect this pass's
 * error-handling sweep found and fixes.** `gatewayFetch`'s `forwardProblem`
 * (`server/utils/gateway.ts`) re-throws the Gateway's problem body via h3's
 * `createError({ statusCode, statusMessage, data: <problem> })`. Left
 * unhandled, that error reaches Nitro's OWN default error handler
 * (`nitropack/dist/runtime/internal/error/{dev,prod}.mjs`), which wraps it
 * AGAIN — one level deeper — into
 * `{ error, url, statusCode, statusMessage, message, data: <the problem we
 * set> }` before it goes over the wire. `ofetch` sets the resulting
 * `FetchError`'s own `.data` to that WHOLE envelope (verified directly in
 * `ofetch`'s own source: `data` is a getter for `response._data`, the raw
 * parsed JSON body) — so the actual problem document a caller needs sits at
 * `error.data.data`, not `error.data` directly.
 *
 * Confirmed live against the real running stack: `curl` a real proxied 400
 * (`GET /api/orders/<not-a-uuid>`) returns
 * `{"error":true,"url":"...","statusCode":400,"statusMessage":"Bad
 * Request","message":"Bad Request","data":{"type":"about:blank","title":"…",
 * "detail":"…","code":"VALIDATION_FAILED",...}}` — `detail`/`code`/`title`
 * one level under the top-level `data`, not at it. Every page's error
 * rendering before this pass read `error.data?.detail`/`error.data?.title`
 * directly — missing this nesting on EVERY error path — so no page ever
 * actually showed the server's real, specific reason; each one silently
 * fell through to its own generic fallback string ("Login failed.",
 * "Placing the order failed.", ...) regardless of what the server said.
 *
 * Defensive about the exact shape regardless of which layer produced it:
 * tries the nested `data.data` first (the real, confirmed-live shape for
 * every route in this app, since all of them go through `gatewayFetch`),
 * falls back to a flat `data` (in case some future/different error path is
 * not double-wrapped), and returns `undefined` if neither looks like a
 * Problem at all.
 */
export function problemFromFetchError(error: unknown): Partial<Problem> | undefined {
  const data = (error as { data?: unknown } | null | undefined)?.data;
  if (!data || typeof data !== 'object') return undefined;

  const nested = (data as { data?: unknown }).data;
  if (nested && typeof nested === 'object' && isProblemLike(nested)) {
    return nested as Partial<Problem>;
  }
  if (isProblemLike(data)) {
    return data as Partial<Problem>;
  }
  return undefined;
}

function isProblemLike(value: object): boolean {
  return 'detail' in value || 'title' in value || 'code' in value;
}

/** The single human-facing line every error-surfacing page renders — the server's own `detail`/`title` when the error carries a real Problem, otherwise `fallback`. */
export function describeFetchError(error: unknown, fallback: string): string {
  const problem = problemFromFetchError(error);
  return problem?.detail ?? problem?.title ?? fallback;
}
