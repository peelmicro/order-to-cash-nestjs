// PR17's producer-side port — one publish, two subjects, built from the
// POST-APPLY document (design.md §7.2), never awaited beyond the publish
// itself. `application/projection-apply.service.ts` calls this from inside
// the `ReadModelWriter`'s `afterApplied` callback (PR18's ordering).
import type { AppliedOrderTimeline } from './read-model-writer.port';

export const UPDATE_SIGNAL_PUBLISHER = Symbol('UpdateSignalPublisher');

export interface UpdateSignalPublisher {
  publish(document: AppliedOrderTimeline): Promise<void>;
}
