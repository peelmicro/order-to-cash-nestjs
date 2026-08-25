// `projectFact` -> `writer.apply(...)` with the signal publication as the
// POST-APPLY callback (design.md §8.2). PR18's ordering (signal only after
// the apply, only when it matched) and PR19's log-and-swallow live HERE and
// NOWHERE ELSE — the writer's `afterApplied` contract (application/ports/read-model-writer.port.ts)
// is what makes "no signal for a duplicate" structural; this service is
// what makes "a failed signal never blocks the fact" a deliberate choice
// rather than an accident of error handling.
import type { Envelope } from '@otc/contracts';
import { projectFact } from '../domain/fact-projection';
import { CONSUMER_NAMES, type ConsumerName } from './ports/consumer-name';
import type { AppliedOrderTimeline, ApplyOutcome, ReadModelWriter } from './ports/read-model-writer.port';
import type { UpdateSignalPublisher } from './ports/update-signal.port';

export interface ProjectionApplyServiceLogger {
  error(message: string, meta: Record<string, unknown>): void;
}

const CONSOLE_LOGGER: ProjectionApplyServiceLogger = {
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};

const CONSUMER: ConsumerName = CONSUMER_NAMES[0];

export class ProjectionApplyService {
  private readonly logger: ProjectionApplyServiceLogger;

  constructor(
    private readonly writer: ReadModelWriter,
    private readonly signalPublisher: UpdateSignalPublisher,
    logger: ProjectionApplyServiceLogger = CONSOLE_LOGGER,
  ) {
    this.logger = logger;
  }

  /**
   * Projects one fact. A writer failure (the Mongo write itself) propagates
   * unchanged, so Kafka redelivers the fact. A SIGNAL publication failure
   * (PR19) is caught and logged INSIDE the `afterApplied` callback below —
   * it never reaches this method's caller, and the fact is acknowledged
   * exactly as if the signal had succeeded, because rethrowing here would
   * produce a redelivery `PR6`'s filter suppresses (the projection already
   * applied) — a guaranteed-failing retry that could never emit the signal
   * and would block the partition forever.
   */
  async apply(envelope: Envelope): Promise<ApplyOutcome> {
    const delta = projectFact(envelope);

    return this.writer.apply(delta, envelope.eventId, CONSUMER, async (document: AppliedOrderTimeline) => {
      try {
        await this.signalPublisher.publish(document);
      } catch (error) {
        this.logger.error('projection-apply.service: update signal publication failed — logged and swallowed (PR19)', {
          eventId: envelope.eventId,
          orderId: document.orderId,
          subjects: [`readmodel.order.updated.${document.orderId}`, `readmodel.timeline.appended.${document.orderId}`],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}
