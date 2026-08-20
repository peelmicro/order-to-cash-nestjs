// The one production implementation of the `Clock` port — everywhere else
// reads time through the port, never `new Date()` directly (so tests can
// control it).
import type { Clock } from '../application/ports/clock.port';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
