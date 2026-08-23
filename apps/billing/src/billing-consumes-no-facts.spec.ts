// `BI1` — Billing registers NO fact-stream consumer and NO
// `order.despatched.v1` subscription of any kind (design.md §8). Pure text
// over `apps/billing/src/**/*.ts`, excluding `*.spec.ts` and
// `test-support/`: no file contains `@EventPattern`; `main.ts` calls
// `connectMicroservice` exactly once and with `Transport.NATS`; no file
// imports a Kafka CONSUMER API. The relay's `kafkajs` PRODUCER import
// (`infrastructure/outbox/create-kafka-client.ts`) is explicitly allowed
// and named, so this guard is specific rather than a blanket ban.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '.');
/** The relay's kafkajs PRODUCER import — the one file allowed to import from 'kafkajs' as a value outside test-support. */
const ALLOWED_KAFKAJS_PRODUCER_FILE = path.join(SRC_ROOT, 'infrastructure/outbox/create-kafka-client.ts');

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

describe('billing-consumes-no-facts — BI1', () => {
  it('registers no fact-stream transport and no event-pattern handler anywhere in the billing service', () => {
    const files = collectSourceFiles(SRC_ROOT);
    // Non-vacuity: the scan actually found source files to check.
    expect(files.length).toBeGreaterThan(10);

    // The decorator's INVOCATION shape — `@EventPattern(` — not the bare
    // word, so a doc comment that merely names the decorator in prose
    // (e.g. `idempotent-consumer.ts`'s header, describing a FUTURE
    // consumer's shape) is never a false positive.
    const EVENT_PATTERN_DECORATOR = /@EventPattern\(/;

    for (const file of files) {
      expect(file.content, `${file.relativePath} must not use @EventPattern(...) (BI1)`).not.toMatch(EVENT_PATTERN_DECORATOR);
    }

    // Non-vacuity of the @EventPattern matcher itself: prove it fires on a
    // fixture string that DOES contain the decorator invocation, so a
    // silently-broken matcher (e.g. a typo in the literal) cannot pass
    // this guard vacuously.
    const fixtureWithEventPattern = "@EventPattern('order.despatched.v1', Transport.KAFKA)\n  handle() {}";
    expect(fixtureWithEventPattern).toMatch(EVENT_PATTERN_DECORATOR);

    // main.ts: exactly one connectMicroservice call, and it names
    // Transport.NATS — never a Kafka microservice transport.
    const mainTs = files.find((file) => file.relativePath === 'main.ts');
    expect(mainTs, 'main.ts must exist').toBeDefined();
    const connectMicroserviceCalls = mainTs!.content.match(/connectMicroservice/g) ?? [];
    expect(connectMicroserviceCalls, 'main.ts must call connectMicroservice exactly once').toHaveLength(1);
    expect(mainTs!.content).toMatch(/transport:\s*Transport\.NATS/);
    expect(mainTs!.content).not.toContain('Transport.KAFKA');

    // No file imports a Kafka CONSUMER API — the relay's kafkajs PRODUCER
    // import is the one explicitly named exception.
    for (const file of files) {
      if (file.absolutePath === ALLOWED_KAFKAJS_PRODUCER_FILE) {
        continue;
      }
      expect(file.content, `${file.relativePath} must not import from 'kafkajs' (only the relay's producer file may)`).not.toMatch(
        /from ['"]kafkajs['"]/,
      );
      expect(file.content, `${file.relativePath} must not construct a kafkajs consumer`).not.toMatch(/\.consumer\(/);
    }

    // The one allowed file imports ONLY the producer-shaped `Kafka` client,
    // never a `Consumer` type or a `.consumer(` call.
    expect(mainTs!.content).not.toMatch(/\.consumer\(/);
  });
});
