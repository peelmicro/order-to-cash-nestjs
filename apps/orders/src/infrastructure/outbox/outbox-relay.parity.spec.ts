// OB1 — the parity guard for the per-service copies of the outbox-relay
// family (design.md §9.4, billing_credit). Modelled case-for-case on
// `apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts`
// and reusing its exact helpers (`findRepoRoot`, `stripBanner`,
// `importSpecifiersOf`, `listApps`) so a reader who has read one has read
// both. Pure text: `node:fs` only, no Docker, runs inside `pnpm quality`.
//
// The canonical family is the seven files named below, all living in this
// same directory. Every other write model's copy must be byte-identical to
// the canonical after ONE normalisation: the leading `//` banner (the
// file's contiguous run of `//` lines from the top) is stripped from both
// sides first. The discriminator between "copy" (compared) and "does not
// apply" is read from the filesystem: does the app own a MySQL `outbox`
// schema.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`outbox-relay.parity.spec: could not find pnpm-workspace.yaml walking up from ${startDir}`);
    }
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(__dirname);

/** The seven files the canonical outbox-relay family comprises (design.md §9.1, §9.3). */
const FAMILY_FILES = [
  'outbox-relay.ts',
  'outbox-relay.service.ts',
  'outbox-relay.config.ts',
  'outbox-envelope-mapper.ts',
  'outbox-recorder.ts',
  'kafka-fact-publisher.ts',
  'create-kafka-client.ts',
] as const;

const CANONICAL_APP = 'orders';

/** The whitelist design.md §9.4 fixes. */
const PORTABLE_IMPORT_WHITELIST = [
  'drizzle-orm',
  'kafkajs',
  '@nestjs/common',
  '@otc/shared-kernel',
  '@otc/contracts',
  '../persistence/client',
  '../persistence/schema',
  '../persistence/drizzle-unit-of-work',
  '../../application/ports/clock.port',
  '../../application/ports/fact-publisher.port',
  '../../application/ports/unit-of-work.port',
  './outbox-relay',
  './outbox-relay.config',
  './outbox-envelope-mapper',
  './kafka.config',
  './create-kafka-client',
  './kafka-fact-publisher',
];

function stripBanner(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.trimStart().startsWith('//')) {
    i++;
  }
  return lines.slice(i).join('\n');
}

function importSpecifiersOf(text: string): string[] {
  const specifiers: string[] = [];
  const fromClause = /from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = fromClause.exec(text)) !== null) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function listApps(): string[] {
  return readdirSync(path.join(REPO_ROOT, 'apps'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function hasMySqlOutboxSchema(app: string): boolean {
  return existsSync(path.join(REPO_ROOT, 'apps', app, 'src/infrastructure/persistence/schema/outbox.schema.ts'));
}

function familyPathOf(app: string, file: string): string {
  return path.join(REPO_ROOT, 'apps', app, 'src/infrastructure/outbox', file);
}

function ownsFullFamily(app: string): boolean {
  return FAMILY_FILES.every((file) => existsSync(familyPathOf(app, file)));
}

describe('outbox-relay.parity — OB1', () => {
  const canonicalBodies = new Map(
    FAMILY_FILES.map((file) => [file, stripBanner(readFileSync(familyPathOf(CANONICAL_APP, file), 'utf8'))] as const),
  );

  it('holds every write model\'s copy of the outbox-relay family byte-identical to the canonical copy', () => {
    const copies = listApps().filter((app) => hasMySqlOutboxSchema(app) && ownsFullFamily(app));

    // Non-vacuity: the canonical (orders) is always a member of its own
    // set, and the set has at least three members — orders, fulfillment
    // and billing — the assertion that says out loud the guard is armed.
    expect(copies).toContain(CANONICAL_APP);
    expect(copies.length, `expected at least 3 copies of the outbox-relay family, found: ${copies.join(', ')}`).toBeGreaterThanOrEqual(3);

    for (const app of copies) {
      for (const file of FAMILY_FILES) {
        const body = stripBanner(readFileSync(familyPathOf(app, file), 'utf8'));
        expect(body, `apps/${app}/src/infrastructure/outbox/${file} diverges from the canonical copy (banner-stripped)`).toBe(
          canonicalBodies.get(file),
        );
      }
    }
  });

  it('keeps the canonical family adoptable verbatim, naming no service and importing nothing service-specific', () => {
    // A plain case-insensitive substring match, deliberately NOT
    // \b-bounded — the same reasoning idempotent-consumer.parity.spec.ts
    // documents: a \b-bounded pattern would miss `OrdersDb` etc.
    const forbiddenServiceName = /orders|fulfillment|billing|projector|notifications/i;

    for (const file of FAMILY_FILES) {
      const body = canonicalBodies.get(file)!;
      expect(body, `${file} names a service outside its banner`).not.toMatch(forbiddenServiceName);

      const specifiers = importSpecifiersOf(body);
      for (const specifier of specifiers) {
        expect(PORTABLE_IMPORT_WHITELIST, `${file}: import "${specifier}" is not in the portable whitelist`).toContain(specifier);
      }
    }
  });

  it('requires the outbox-relay family from every application that owns a MySQL outbox schema', () => {
    const violations = listApps().filter((app) => hasMySqlOutboxSchema(app) && !ownsFullFamily(app));

    expect(
      violations,
      `app(s) with a MySQL outbox schema but an incomplete outbox-relay family: ${violations.join(', ')}`,
    ).toEqual([]);
  });
});
