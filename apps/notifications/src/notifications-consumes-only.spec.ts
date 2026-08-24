// NS9 — this service only consumes: it answers NO RPC (no `@MessagePattern`
// anywhere), emits NO fact (no outbox, no Kafka PRODUCER usage outside
// test-support) and connects EXACTLY ONE microservice transport
// (`Transport.KAFKA`, main.ts). Same "pure text scan over every source
// file, one allow-listed exception, non-vacuity proven against a fixture"
// shape apps/billing/src/billing-consumes-no-facts.spec.ts (BI1) uses, in
// the opposite direction: billing forbids `@EventPattern`, this forbids
// `@MessagePattern` and a Kafka PRODUCER.
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

describe('notifications-consumes-only — NS9', () => {
  it('registers no RPC responder (@MessagePattern) and no outbound Kafka producer anywhere in the notifications service', () => {
    const files = collectSourceFiles(SRC_ROOT);
    // Non-vacuity: the scan actually found source files to check.
    expect(files.length).toBeGreaterThan(10);

    // The decorator's INVOCATION shape — not the bare word, so a doc
    // comment naming the decorator in prose is never a false positive.
    const MESSAGE_PATTERN_DECORATOR = /@MessagePattern\(/;

    for (const file of files) {
      expect(file.content, `${file.relativePath} must not use @MessagePattern(...) (NS9 — this service answers no RPC)`).not.toMatch(
        MESSAGE_PATTERN_DECORATOR,
      );
      expect(file.content, `${file.relativePath} must not call .producer( (NS9 — this service emits no fact and has no outbox)`).not.toMatch(
        /\.producer\(/,
      );
    }

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
