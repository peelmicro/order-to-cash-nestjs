// ONE command, carrying the envelope (PR27) — the projector's behaviour
// does not vary with `eventType` (all thirteen variations live inside the
// pure `domain/fact-projection.ts`), so thirteen command classes would be
// thirteen empty subclasses routed to identical handlers (design.md §9.3,
// open point 6).
import type { Envelope } from '@otc/contracts';

export class ProjectFactCommand {
  constructor(public readonly envelope: Envelope) {}
}
