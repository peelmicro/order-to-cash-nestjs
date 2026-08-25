// F3 (review) — the recency window `GetOrderHandler` bounds R55's 202
// response by. `ttlMs` defaults to 5 minutes: comfortably longer than any
// realistic outbox→Kafka→projector lag (seconds, not minutes) while still
// bounded — a false 202 self-corrects the moment the window expires,
// unlike the unconditional 202 this replaces. `capacity` bounds memory
// the same way `ReplayBuffer`'s does for the SSE stream.
export interface IssuedOrderWindowConfig {
  readonly ttlMs: number;
  readonly capacity: number;
}

export function loadIssuedOrderWindowConfig(env: NodeJS.ProcessEnv = process.env): IssuedOrderWindowConfig {
  return {
    ttlMs: Number(env.GATEWAY_ISSUED_ORDER_WINDOW_TTL_MS ?? 300_000),
    capacity: Number(env.GATEWAY_ISSUED_ORDER_WINDOW_CAPACITY ?? 10_000),
  };
}
