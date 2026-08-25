// The SSE frame `id:` field (openapi.yaml `/orders/stream`'s frame-format
// section: `id: 1755511234567-17`) — an opaque, monotonically increasing
// cursor. Epoch-millisecond prefix (so a cursor is roughly time-ordered for
// a human reading raw frames) plus a per-instance sequence suffix (so two
// frames emitted within the same millisecond never collide). Pure — takes
// a clock port, not `Date.now()` directly, so it is deterministic under
// test.
export interface CursorClock {
  now(): Date;
}

export class CursorGenerator {
  private sequence = 0;

  constructor(private readonly clock: CursorClock) {}

  next(): string {
    this.sequence += 1;
    return `${this.clock.now().getTime()}-${this.sequence}`;
  }
}
