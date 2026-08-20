// The clock port `orders_aggregate` §4.6 said would live in the application
// layer (`Order` itself never reads a clock — every timestamp is passed in
// through `TransitionContext`). It lands here because the outbox recorder
// (`created_at`) and the relay (`published_at`) are its first infrastructure
// users — see design.md §4.4 and §5.1.
export const CLOCK = Symbol('Clock');

export interface Clock {
  now(): Date;
}
