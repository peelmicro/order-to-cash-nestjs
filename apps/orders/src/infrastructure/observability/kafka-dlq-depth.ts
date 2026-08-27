// A7's real `DlqDepthPort` adapter (`observability_reliability`
// design.md §4.5, R59/OR5) — a broker admin-client partition-offset query
// against each `.dlq` topic: `admin.fetchTopicOffsets(topic)` returns
// `{ high, low }` PER PARTITION; depth is `Σ(high - low)` across
// partitions, the message count CURRENTLY sitting in that topic (not
// merely "ever produced" — `low` accounts for anything evicted by
// retention). A topic that does not exist yet (nothing has ever been
// dead-lettered to it) throws `UNKNOWN_TOPIC_OR_PARTITION` from kafkajs;
// caught per-topic and reported as depth 0 — a topic no one has ever
// published to genuinely has zero backlog, not an error condition.
import type { Admin } from 'kafkajs';
import type { DlqDepthPort } from '../outbox/outbox-relay';

export class KafkaDlqDepth implements DlqDepthPort {
  constructor(private readonly admin: Admin) {}

  async fetchDepths(topics: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const result = new Map<string, number>();
    await Promise.all(
      topics.map(async (topic) => {
        try {
          const partitions = await this.admin.fetchTopicOffsets(topic);
          const depth = partitions.reduce((sum, partition) => sum + (Number(partition.high) - Number(partition.low)), 0);
          result.set(topic, depth);
        } catch {
          result.set(topic, 0);
        }
      }),
    );
    return result;
  }
}
