// Same shape every other service's `clock.port.ts` establishes — a single
// injectable seam so tests can freeze time instead of stubbing `Date`.
export const CLOCK = Symbol('Clock');

export interface Clock {
  now(): Date;
}
