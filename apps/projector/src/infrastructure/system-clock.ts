// The one production implementation of the `Clock` port — used for log
// lines only (clock.port.ts's header). Everywhere else reads time through
// the port, never `new Date()` directly, so tests can control it.
import type { Clock } from '../application/ports/clock.port';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
