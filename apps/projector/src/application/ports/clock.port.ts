// The clock port — used for LOG LINES ONLY (design.md §2). No document
// field is ever written from this port: `updatedAt` comes from the
// envelope's own `occurredAt` (PR14), never from the wall clock. A task
// that puts `clock.now()` into a document field violates PR14 — see
// domain/order-status-rank.ts and infrastructure/persistence/delta-to-pipeline.ts,
// neither of which import this port at all.
export const CLOCK = Symbol('Clock');

export interface Clock {
  now(): Date;
}
