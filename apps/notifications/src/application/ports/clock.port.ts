// The clock port the canonical idempotent-consumer pattern requires (its
// `processedAt` timestamp) — same shape every other write model's
// clock.port.ts establishes. Nothing else in this service reads a clock:
// templates stamp nothing themselves, and `occurredAt` on every rendered
// message comes from the fact's own envelope, not from this port.
export const CLOCK = Symbol('Clock');

export interface Clock {
  now(): Date;
}
