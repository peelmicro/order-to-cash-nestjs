// Guards the "never hardcode a topic" discipline `infra/kafka/create-topics.sh`
// established, without adding a YAML parser dependency to this service
// (design.md §5.3): reads `specs/shared/asyncapi.yaml` as TEXT and asserts
// `ORDERS_FACTS_TOPIC` equals the `ordersFacts` channel's
// `bindings.kafka.topic`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BILLING_FACTS_TOPIC, FULFILLMENT_FACTS_TOPIC, loadKafkaConfig, ORDERS_FACTS_TOPIC } from './kafka.config';

const ASYNCAPI_SPEC_PATH = path.resolve(__dirname, '../../../../../specs/shared/asyncapi.yaml');

function channelBlock(specText: string, channelName: string): string {
  const match = specText.match(new RegExp(`\\n {2}${channelName}:\\n([\\s\\S]*?)\\n {2}\\S`));
  if (!match) {
    throw new Error(`kafka.config.spec: could not locate the ${channelName} channel block in asyncapi.yaml`);
  }
  return match[1]!;
}

function kafkaTopicOf(block: string): string {
  const topicMatch = block.match(/bindings:\s*\n\s*kafka:\s*\n\s*topic:\s*(\S+)/);
  if (!topicMatch) {
    throw new Error('kafka.config.spec: channel block has no bindings.kafka.topic');
  }
  return topicMatch[1]!;
}

describe('kafka.config — uses the fact topics the AsyncAPI channels declare', () => {
  it('uses the fact topic the AsyncAPI ordersFacts channel declares', () => {
    const specText = readFileSync(ASYNCAPI_SPEC_PATH, 'utf8');
    expect(ORDERS_FACTS_TOPIC).toBe(kafkaTopicOf(channelBlock(specText, 'ordersFacts')));
  });

  it('uses the fact topics the AsyncAPI fulfillmentFacts and billingFacts channels declare (order_saga_orchestrator, design.md §3.1)', () => {
    const specText = readFileSync(ASYNCAPI_SPEC_PATH, 'utf8');
    expect(FULFILLMENT_FACTS_TOPIC).toBe(kafkaTopicOf(channelBlock(specText, 'fulfillmentFacts')));
    expect(BILLING_FACTS_TOPIC).toBe(kafkaTopicOf(channelBlock(specText, 'billingFacts')));
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
