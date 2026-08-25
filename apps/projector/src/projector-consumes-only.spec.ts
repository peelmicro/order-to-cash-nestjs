// PR1 › registers exactly three Kafka event-pattern handlers, each
// explicitly transport-bound, and no request-reply responder anywhere in
// the projector. PR21 › declares no write-model dependency and issues no
// RPC request to any service subject. Same "pure text scan over every
// source file, non-vacuity proven against a fixture" shape
// apps/notifications/src/notifications-consumes-only.spec.ts /
// apps/billing/src/billing-consumes-no-facts.spec.ts use.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '.');
const PACKAGE_JSON_PATH = path.resolve(__dirname, '../package.json');

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

describe('projector-consumes-only — PR1/PR21', () => {
  it('registers no RPC responder (@MessagePattern) anywhere in the projector', () => {
    const files = collectSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(10);

    const MESSAGE_PATTERN_DECORATOR = /@MessagePattern\(/;
    for (const file of files) {
      expect(file.content, `${file.relativePath} must not use @MessagePattern(...) (PR1 — the projector answers no query)`).not.toMatch(
        MESSAGE_PATTERN_DECORATOR,
      );
    }

    // Non-vacuity of the matcher itself.
    const fixtureWithMessagePattern = "@MessagePattern('orders.create', Transport.NATS)\n  handle() {}";
    expect(fixtureWithMessagePattern).toMatch(MESSAGE_PATTERN_DECORATOR);
  });

  it('registers exactly three explicitly transport-bound @EventPattern(TOPIC, Transport.KAFKA) handlers', () => {
    const files = collectSourceFiles(SRC_ROOT);
    const eventPatternCalls = files.flatMap((file) =>
      [...file.content.matchAll(/@EventPattern\(([^)]*)\)/g)].map((match) => ({ file: file.relativePath, args: match[1]! })),
    );

    expect(eventPatternCalls).toHaveLength(3);
    for (const call of eventPatternCalls) {
      expect(call.args, `${call.file}: @EventPattern(...) must explicitly bind Transport.KAFKA`).toMatch(/Transport\.KAFKA/);
    }

    // Non-vacuity: a bare (untransported) pattern is distinguishable.
    const bareFixture = "@EventPattern('orders.facts')";
    const bareArgs = [...bareFixture.matchAll(/@EventPattern\(([^)]*)\)/g)][0]![1]!;
    expect(bareArgs).not.toMatch(/Transport\.KAFKA/);
  });

  it('main.ts calls connectMicroservice exactly once, and it names Transport.KAFKA — never Transport.NATS', () => {
    const files = collectSourceFiles(SRC_ROOT);
    const mainTs = files.find((file) => file.relativePath === 'main.ts');
    expect(mainTs, 'main.ts must exist').toBeDefined();

    const connectMicroserviceCalls = mainTs!.content.match(/\.connectMicroservice[<(]/g) ?? [];
    expect(connectMicroserviceCalls, 'main.ts must call connectMicroservice exactly once').toHaveLength(1);
    expect(mainTs!.content).toMatch(/transport:\s*Transport\.KAFKA/);
    expect(mainTs!.content).not.toContain('Transport.NATS');
  });

  it('PR21 › issues no NATS request to any orders.*/fulfillment.*/billing.*/catalog.* RPC subject (publish-only)', () => {
    const files = collectSourceFiles(SRC_ROOT);
    for (const file of files) {
      expect(file.content, `${file.relativePath} must not call .request( on any NatsConnection (PR21 — no RPC to any write model)`).not.toMatch(
        /\.request\(/,
      );
    }

    // Non-vacuity.
    const fixtureWithRequest = 'await connection.request(\'orders.create\', data, { timeout: 5000 })';
    expect(fixtureWithRequest).toMatch(/\.request\(/);
  });

  it('PR21 › declares no Drizzle dependency in package.json (no write-model access)', () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    expect(Object.keys(allDeps)).not.toContain('drizzle-orm');
    expect(Object.keys(allDeps)).not.toContain('mysql2');
  });
});
