// Guards the "never hardcode a topic" discipline `infra/kafka/create-topics.sh`
// established, without adding a YAML parser dependency to this service
// (design.md §5.3): reads `specs/shared/asyncapi.yaml` as TEXT and asserts
// `ORDERS_FACTS_TOPIC` equals the `ordersFacts` channel's
// `bindings.kafka.topic`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadKafkaConfig, ORDERS_FACTS_TOPIC } from './kafka.config';

const ASYNCAPI_SPEC_PATH = path.resolve(__dirname, '../../../../../specs/shared/asyncapi.yaml');

function ordersFactsChannelBlock(specText: string): string {
  const match = specText.match(/\n {2}ordersFacts:\n([\s\S]*?)\n {2}\S/);
  if (!match) {
    throw new Error('kafka.config.spec: could not locate the ordersFacts channel block in asyncapi.yaml');
  }
  return match[1]!;
}

describe('kafka.config — uses the fact topic the AsyncAPI channel declares', () => {
  it('uses the fact topic the AsyncAPI channel declares', () => {
    const specText = readFileSync(ASYNCAPI_SPEC_PATH, 'utf8');
    const block = ordersFactsChannelBlock(specText);

    const topicMatch = block.match(/bindings:\s*\n\s*kafka:\s*\n\s*topic:\s*(\S+)/);
    expect(topicMatch, 'ordersFacts channel has no bindings.kafka.topic').not.toBeNull();

    expect(ORDERS_FACTS_TOPIC).toBe(topicMatch![1]);
  });

  it('defaults KAFKA_BROKERS to localhost:9092 and KAFKA_CLIENT_ID to otc-orders (design.md §8)', () => {
    const config = loadKafkaConfig({});

    expect(config.brokers).toEqual(['localhost:9092']);
    expect(config.clientId).toBe('otc-orders');
  });

  it('splits a comma-separated KAFKA_BROKERS into a trimmed broker list', () => {
    const config = loadKafkaConfig({ KAFKA_BROKERS: 'broker-1:9092, broker-2:9092' });

    expect(config.brokers).toEqual(['broker-1:9092', 'broker-2:9092']);
  });
});
