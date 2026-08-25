// F3 (review finding) — R55's clause is scoped: "WHILE no read-model
// document yet exists for an order identifier THAT THE CALLER HAS JUST
// BEEN GIVEN". A caller who was never given an id is not in that clause,
// and openapi.yaml's own `GET /orders/{id}` description says a genuine
// 404 means the identifier is unknown to the system. The gateway is
// exactly the component that HANDS OUT the id (`OrdersController.placeOrder`
// returns it and sets `Location`), so "an id the caller has just been
// given" is, by construction, an id THIS PROCESS ISSUED recently — no new
// RPC subject is needed to answer this honestly.
//
// A bounded, TTL'd recency window: `record(orderId)` on every successful
// `POST /orders`, `isRecentlyIssued(orderId)` on every `GET /orders/{id}`
// miss. Oldest-evicted-first once `capacity` is exceeded (bounded memory,
// same discipline `ReplayBuffer` uses for the SSE stream) — this is
// deliberately NOT a permanent memory of every order ever placed, only of
// ones recent enough that "still catching up to the read model" is a
// credible explanation for their absence.
//
// Pure — no NestJS, no I/O, no `Date.now()` directly (a `Clock`-shaped
// port instead) — so it is unit-testable without a clock mock library and
// the ESLint domain-purity guard leaves it alone.
export interface IssuedOrderWindowClock {
  now(): Date;
}

export class IssuedOrderWindow {
  private readonly issuedAtMs = new Map<string, number>();

  constructor(
    private readonly clock: IssuedOrderWindowClock,
    private readonly ttlMs: number,
    private readonly capacity: number,
  ) {
    if (ttlMs < 1) {
      throw new Error('IssuedOrderWindow: ttlMs must be at least 1');
    }
    if (capacity < 1) {
      throw new Error('IssuedOrderWindow: capacity must be at least 1');
    }
  }

  record(orderId: string): void {
    this.issuedAtMs.set(orderId, this.clock.now().getTime());
    while (this.issuedAtMs.size > this.capacity) {
      const oldestKey = this.issuedAtMs.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.issuedAtMs.delete(oldestKey);
    }
  }

  /** True while `orderId` was `record()`-ed within the last `ttlMs`. Expired entries are evicted on the read that finds them, so the window never answers `true` for a stale entry it happens to still be holding. */
  isRecentlyIssued(orderId: string): boolean {
    const issuedAt = this.issuedAtMs.get(orderId);
    if (issuedAt === undefined) {
      return false;
    }
    const age = this.clock.now().getTime() - issuedAt;
    if (age > this.ttlMs) {
      this.issuedAtMs.delete(orderId);
      return false;
    }
    return true;
  }

  get size(): number {
    return this.issuedAtMs.size;
  }
}
