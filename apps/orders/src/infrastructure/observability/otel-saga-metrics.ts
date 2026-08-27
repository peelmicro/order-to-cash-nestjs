// A7's real `RecordsSagaMetrics` adapter (`observability_reliability`
// design.md §4.5, R59/OR5) — records `otc_saga_completion_ms` via the
// same globally-resolved `Meter` `metrics.ts`'s other instruments use.
import type { RecordsSagaMetrics, SagaCompletionOutcome } from '../../application/ports/saga-metrics.port.js';
import { sagaCompletionHistogram } from './metrics.js';

export class OtelSagaMetrics implements RecordsSagaMetrics {
  recordSagaCompletion(durationMs: number, outcome: SagaCompletionOutcome): void {
    sagaCompletionHistogram().record(durationMs, { outcome });
  }
}
