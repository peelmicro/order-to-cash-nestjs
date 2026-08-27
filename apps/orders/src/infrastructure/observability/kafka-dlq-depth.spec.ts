// Pure unit — A7 (metrics, R59/OR5, design.md §4.5): `KafkaDlqDepth`'s own
// arithmetic (`Σ(high - low)` across partitions) and its "topic not found
// → depth 0, never throws" behaviour, against a fake `Admin`.
import { describe, expect, it } from 'vitest';
import type { Admin } from 'kafkajs';
import { KafkaDlqDepth } from './kafka-dlq-depth';

function fakeAdmin(byTopic: Record<string, Array<{ partition: number; high: string; low: string }>>): Admin {
  return {
    fetchTopicOffsets: async (topic: string) => {
      const partitions = byTopic[topic];
      if (!partitions) {
        throw new Error(`KafkaJSProtocolError: This server does not host this topic-partition (${topic})`);
      }
      return partitions.map((p) => ({ ...p, offset: p.high }));
    },
  } as unknown as Admin;
}

describe('KafkaDlqDepth (A7, R59, OR5, design.md §4.5)', () => {
  it('sums (high - low) across every partition of a topic', async () => {
    const admin = fakeAdmin({
      'otc.orders.facts.v1.dlq': [
        { partition: 0, high: '10', low: '2' },
        { partition: 1, high: '5', low: '0' },
        { partition: 2, high: '3', low: '3' },
      ],
    });
    const depth = new KafkaDlqDepth(admin);

    const result = await depth.fetchDepths(['otc.orders.facts.v1.dlq']);

    expect(result.get('otc.orders.facts.v1.dlq')).toBe(8 + 5 + 0); // (10-2) + (5-0) + (3-3)
  });

  it('reports depth 0 (never throws) for a topic that does not exist yet', async () => {
    const admin = fakeAdmin({});
    const depth = new KafkaDlqDepth(admin);

    const result = await depth.fetchDepths(['otc.billing.facts.v1.dlq']);

    expect(result.get('otc.billing.facts.v1.dlq')).toBe(0);
  });

  it('queries every requested topic independently — one missing topic does not suppress another\'s real depth', async () => {
    const admin = fakeAdmin({
      'otc.orders.facts.v1.dlq': [{ partition: 0, high: '4', low: '0' }],
    });
    const depth = new KafkaDlqDepth(admin);

    const result = await depth.fetchDepths(['otc.orders.facts.v1.dlq', 'otc.fulfillment.facts.v1.dlq']);

    expect(result.get('otc.orders.facts.v1.dlq')).toBe(4);
    expect(result.get('otc.fulfillment.facts.v1.dlq')).toBe(0);
  });
});
