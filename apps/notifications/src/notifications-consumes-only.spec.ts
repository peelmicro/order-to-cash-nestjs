// NS9 — this service only consumes: it answers NO RPC (no `@MessagePattern`
// anywhere), emits NO business fact (no outbox, no Kafka PRODUCER usage
// outside test-support) and connects EXACTLY ONE microservice transport
// (`Transport.KAFKA`, main.ts). Same "pure text scan over every source
// file, one allow-listed exception, non-vacuity proven against a fixture"
// shape apps/billing/src/billing-consumes-no-facts.spec.ts (BI1) uses, in
// the opposite direction: billing forbids `@EventPattern`, this forbids
// `@MessagePattern` and a Kafka PRODUCER.
//
// ONE narrow, conscious amendment (A4b, observability_reliability
// design.md §4.1): `infrastructure/messaging/kafka-dlq-publisher.ts` DOES
// call `.producer(` — it is OR1's DLQ adapter, publishing the UNMODIFIED
// original fact to `<sourceTopic>.dlq` on retry exhaustion, never a NEW
// business fact and never an outbox (this service still has none — the
// "no outbox-relay file" scan below is unchanged and still fails loudly
// on one). `KAFKA_DLQ_PUBLISHER_ALLOW_LIST` below is the one, explicit,
// self-validating exception; anything else calling `.producer(` still
// fails this test.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '.');

interface SourceFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly content: string;
}

function collectSourceFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const absolutePath = path.join(dir, entry);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        if (entry === 'test-support' || entry === 'node_modules') {
          continue;
        }
        walk(absolutePath);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) {
        continue;
      }
      files.push({ absolutePath, relativePath: path.relative(SRC_ROOT, absolutePath), content: readFileSync(absolutePath, 'utf8') });
    }
  }

  walk(root);
  return files;
}

/** The ONE file allowed to call `.producer(` — see this file's own header for why (A4b's DLQ adapter, not a business-fact emitter). */
const KAFKA_DLQ_PUBLISHER_ALLOW_LIST = ['infrastructure/messaging/kafka-dlq-publisher.ts'];

describe('notifications-consumes-only — NS9', () => {
  it('registers no RPC responder (@MessagePattern) and no outbound Kafka producer anywhere in the notifications service, except A4b\'s one named DLQ adapter', () => {
    const files = collectSourceFiles(SRC_ROOT);
    // Non-vacuity: the scan actually found source files to check.
    expect(files.length).toBeGreaterThan(10);

    // The decorator's INVOCATION shape — not the bare word, so a doc
    // comment naming the decorator in prose is never a false positive.
    const MESSAGE_PATTERN_DECORATOR = /@MessagePattern\(/;

    const filesCallingProducer: string[] = [];
    for (const file of files) {
      expect(file.content, `${file.relativePath} must not use @MessagePattern(...) (NS9 — this service answers no RPC)`).not.toMatch(
        MESSAGE_PATTERN_DECORATOR,
      );
      if (/\.producer\(/.test(file.content)) {
        filesCallingProducer.push(file.relativePath);
      }
    }

    // Self-validating (same discipline OI12's registry uses): the ONLY
    // file(s) calling `.producer(` must be EXACTLY the allow-listed DLQ
    // adapter — not zero (that would mean the allow-list itself is stale)
    // and not any other file (that would mean a new, un-reviewed producer
    // slipped in, e.g. a future outbox).
    expect(
      filesCallingProducer,
      `files calling .producer(: ${filesCallingProducer.join(', ') || '(none)'}; expected exactly ${KAFKA_DLQ_PUBLISHER_ALLOW_LIST.join(', ')}`,
    ).toEqual(KAFKA_DLQ_PUBLISHER_ALLOW_LIST);

    // Non-vacuity of the @MessagePattern matcher itself.
    const fixtureWithMessagePattern = "@MessagePattern('orders.create', Transport.NATS)\n  handle() {}";
    expect(fixtureWithMessagePattern).toMatch(MESSAGE_PATTERN_DECORATOR);

    // main.ts: exactly one connectMicroservice call, and it names
    // Transport.KAFKA — never a NATS microservice transport.
    const mainTs = files.find((file) => file.relativePath === 'main.ts');
    expect(mainTs, 'main.ts must exist').toBeDefined();
    const connectMicroserviceCalls = mainTs!.content.match(/connectMicroservice/g) ?? [];
    expect(connectMicroserviceCalls, 'main.ts must call connectMicroservice exactly once').toHaveLength(1);
    expect(mainTs!.content).toMatch(/transport:\s*Transport\.KAFKA/);
    expect(mainTs!.content).not.toContain('Transport.NATS');

    // No outbox/relay files anywhere (this service has no aggregate, no
    // unit of work and nothing to publish).
    for (const file of files) {
      expect(file.relativePath, 'no outbox-relay file should exist in notifications').not.toMatch(/outbox/i);
    }
  });
});
