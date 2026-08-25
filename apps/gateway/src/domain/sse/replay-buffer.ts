// The stream's "bounded replay buffer" (openapi.yaml `/orders/stream`
// reconnection section, R55): a fixed-capacity, oldest-evicted-first
// history of every frame emitted, keyed by its opaque cursor. Pure — no
// NestJS, no I/O, no clock even — a ring buffer is exactly this and
// nothing more.
//
// The two honest limitations openapi.yaml states are both structural
// consequences of this shape, not special-cased: (1) a cursor older than
// the oldest surviving entry is indistinguishable from a cursor that never
// existed — `replayAfter` returns `resumed: false` for both, and the
// caller (the stream controller) is the one that turns that into
// `stream.ready { resumed: false }` plus "go re-fetch the read model" doc.
// (2) delivery is at-least-once because a frame already relayed to a slow
// consumer can still be re-sent on reconnect if the consumer's own
// `Last-Event-ID` lagged behind what it actually received — this buffer
// makes no promise about exactly-once, only about "give me everything
// after this cursor, if I still have it".
export interface ReplayResult<T> {
  readonly resumed: boolean;
  readonly missed: readonly T[];
}

export class ReplayBuffer<T> {
  private readonly entries: { cursor: string; value: T }[] = [];

  constructor(private readonly capacity: number) {
    if (capacity < 1) {
      throw new Error('ReplayBuffer: capacity must be at least 1');
    }
  }

  push(cursor: string, value: T): void {
    this.entries.push({ cursor, value });
    while (this.entries.length > this.capacity) {
      this.entries.shift();
    }
  }

  /**
   * `cursor` is `undefined` for a fresh connection (no `Last-Event-ID`
   * header at all) — never a resume, `resumed: false`, nothing missed by
   * definition (there is nothing to have missed).
   */
  replayAfter(cursor: string | undefined): ReplayResult<T> {
    if (cursor === undefined) {
      return { resumed: false, missed: [] };
    }
    const index = this.entries.findIndex((entry) => entry.cursor === cursor);
    if (index === -1) {
      return { resumed: false, missed: [] };
    }
    return { resumed: true, missed: this.entries.slice(index + 1).map((entry) => entry.value) };
  }

  get size(): number {
    return this.entries.length;
  }
}
