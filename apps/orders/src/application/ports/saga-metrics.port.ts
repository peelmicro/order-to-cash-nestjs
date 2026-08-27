// A7's `otc_saga_completion_ms` port (`observability_reliability`
// design.md §4.5, R59/OR5) — a narrow, separately injected collaborator,
// the SAME "not four new constructor params, one small port with a no-op
// default" shape `HandlesFirstPark` (OR3, `saga-command-dispatcher.ts`)
// already established, so `SagaFactHandler`'s existing tests/call sites
// stay unaffected by a concern this class has no other stake in.

export type SagaCompletionOutcome = 'completed' | 'cancelled';

export interface RecordsSagaMetrics {
  /** `durationMs` — the real wall-clock span from the order's OWN `order.placed.v1` timestamp (`Order.orderDate`) to the fact whose processing just closed the saga. */
  recordSagaCompletion(durationMs: number, outcome: SagaCompletionOutcome): void;
}

export const NOOP_SAGA_METRICS: RecordsSagaMetrics = {
  recordSagaCompletion(): void {
    /* no-op default — A7 is opt-in via SagaFactHandler's constructor */
  },
};
