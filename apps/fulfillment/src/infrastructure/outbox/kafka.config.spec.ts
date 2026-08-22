// COPY OF — apps/orders/src/infrastructure/outbox/kafka.config.spec.ts
// Guards the "never hardcode a topic" discipline `infra/kafka/create-topics.sh`
// established: reads `specs/shared/asyncapi.yaml` as TEXT and asserts
// `FULFILLMENT_FACTS_TOPIC` equals the `fulfillmentFacts` channel's
// `bindings.kafka.topic`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FULFILLMENT_FACTS_TOPIC, loadKafkaConfig } from './kafka.config';

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

describe('kafka.config — uses the fact topic the AsyncAPI fulfillmentFacts channel declares', () => {
  it('uses the fact topic the AsyncAPI fulfillmentFacts channel declares', () => {
    const specText = readFileSync(ASYNCAPI_SPEC_PATH, 'utf8');
    expect(FULFILLMENT_FACTS_TOPIC).toBe(kafkaTopicOf(channelBlock(specText, 'fulfillmentFacts')));
  });

  it('defaults KAFKA_BROKERS to localhost:9092 and FULFILLMENT_KAFKA_CLIENT_ID to otc-fulfillment (design.md §12)', () => {
    const config = loadKafkaConfig({});

    expect(config.brokers).toEqual(['localhost:9092']);
    expect(config.clientId).toBe('otc-fulfillment');
  });

  it('splits a comma-separated KAFKA_BROKERS into a trimmed broker list', () => {
    const config = loadKafkaConfig({ KAFKA_BROKERS: 'broker-1:9092, broker-2:9092' });

    expect(config.brokers).toEqual(['broker-1:9092', 'broker-2:9092']);
  });
});
