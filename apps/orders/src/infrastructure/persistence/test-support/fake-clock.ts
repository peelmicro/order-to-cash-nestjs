// A controllable `Clock` for tests — CLAUDE.md § Testing conventions: time
// comes from a controllable clock port, never a live `new Date()` read
// inside a test's production path.
import type { Clock } from '../../../application/ports/clock.port';

export class FakeClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  set(date: Date): void {
    this.current = date;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
