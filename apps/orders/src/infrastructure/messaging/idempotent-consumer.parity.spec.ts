// OI12 — the parity guard for the per-service copies of the
// idempotent-consumer pattern (design.md §6.4). Pure text: `node:fs` +
// `readdirSync('apps')` only, repo root resolved by walking up from
// `import.meta.url`'s CommonJS equivalent (`__dirname`) to the directory
// holding `pnpm-workspace.yaml` — no glob package, no new dependency, no
// Docker, so it runs inside `pnpm quality`.
//
// The canonical pair is `idempotent-consumer.ts` +
// `processed-events.repository.ts`, both in this same directory. Every
// other MySQL write model's copy must be byte-identical to the canonical
// after ONE normalisation: the leading `//` banner (the file's
// contiguous run of `//` lines from the top) is stripped from both sides
// first. The discriminator between "copy" (compared) and "variant" (never
// compared, but must document its divergence) is read from the
// filesystem: does the app own a MySQL `processed_events` schema.
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
      throw new Error(`idempotent-consumer.parity.spec: could not find pnpm-workspace.yaml walking up from ${startDir}`);
    }
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(__dirname);
const CANONICAL_PATH_LITERAL = 'apps/orders/src/infrastructure/messaging/idempotent-consumer.ts';
const CANONICAL_CONSUMER_PATH = path.join(REPO_ROOT, CANONICAL_PATH_LITERAL);
const CANONICAL_REPO_PATH = path.join(
  REPO_ROOT,
  'apps/orders/src/infrastructure/messaging/processed-events.repository.ts',
);

/** The whitelist design.md §6.4 fixes — satisfiable today because all three MySQL write models already export `processedEvents` from an identically-named, identically-pathed file, and the ports of group C are per-service files at identical paths. */
const PORTABLE_IMPORT_WHITELIST = [
  '../../application/ports/unit-of-work.port',
  '../../application/ports/clock.port',
  '../../application/ports/consumer-name',
  '../persistence/schema/processed-events.schema',
  '../persistence/drizzle-unit-of-work',
  '@otc/shared-kernel',
  'drizzle-orm',
  // Not enumerated in design.md §6.4's list, but trivially portable and
  // consistent with its stated intent ("resolves to the same relative path
  // in every service tree"): the two canonical files are copied TOGETHER
  // (G7), always co-located at infrastructure/messaging/, so the sibling
  // reference between them exists at the same relative path in every copy
  // by construction.
  './processed-events.repository',
];

function stripBanner(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.trimStart().startsWith('//')) {
    i++;
  }
  return lines.slice(i).join('\n');
}

function bannerOf(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.trimStart().startsWith('//')) {
    i++;
  }
  return lines.slice(0, i).join('\n');
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

function hasMySqlProcessedEventsSchema(app: string): boolean {
  return existsSync(
    path.join(REPO_ROOT, 'apps', app, 'src/infrastructure/persistence/schema/processed-events.schema.ts'),
  );
}

function idempotentConsumerPathOf(app: string): string {
  return path.join(REPO_ROOT, 'apps', app, 'src/infrastructure/messaging/idempotent-consumer.ts');
}

function processedEventsRepositoryPathOf(app: string): string {
  return path.join(REPO_ROOT, 'apps', app, 'src/infrastructure/messaging/processed-events.repository.ts');
}

function walkTsFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** A real `@EventPattern(...)` decorator use, never a comment mentioning the word (the census must not self-trigger on this very file's banner, which names it in prose). */
function hasEventPatternHandler(app: string): boolean {
  const srcDir = path.join(REPO_ROOT, 'apps', app, 'src');
  return walkTsFiles(srcDir).some((file) => /@EventPattern\s*\(/.test(readFileSync(file, 'utf8')));
}

describe('idempotent-consumer.parity — OI12', () => {
  const canonicalConsumerText = readFileSync(CANONICAL_CONSUMER_PATH, 'utf8');
  const canonicalRepoText = readFileSync(CANONICAL_REPO_PATH, 'utf8');
  const canonicalConsumerBody = stripBanner(canonicalConsumerText);
  const canonicalRepoBody = stripBanner(canonicalRepoText);

  it('holds every write model\'s copy of the idempotent-consumer pattern byte-identical to the canonical copy', () => {
    const copies = listApps().filter(
      (app) => hasMySqlProcessedEventsSchema(app) && existsSync(idempotentConsumerPathOf(app)),
    );

    // Non-vacuity: the canonical (orders) is always a member of its own set.
    expect(copies).toContain('orders');

    if (copies.length === 1) {
      // Only the canonical exists yet (features 17-22 add the rest) — the
      // comparison below is then only "the canonical equals itself", and
      // this assertion says so rather than passing silently for the wrong
      // reason.
      expect(copies, 'only the canonical copy exists today — arms at feature 17').toEqual(['orders']);
    }

    for (const app of copies) {
      const consumerBody = stripBanner(readFileSync(idempotentConsumerPathOf(app), 'utf8'));
      const repoBody = stripBanner(readFileSync(processedEventsRepositoryPathOf(app), 'utf8'));
      expect(consumerBody, `apps/${app}'s idempotent-consumer.ts diverges from the canonical copy (banner-stripped)`).toBe(
        canonicalConsumerBody,
      );
      expect(
        repoBody,
        `apps/${app}'s processed-events.repository.ts diverges from the canonical copy (banner-stripped)`,
      ).toBe(canonicalRepoBody);
    }
  });

  it('keeps the canonical copy adoptable verbatim, naming no service and importing nothing service-specific', () => {
    // A plain case-insensitive substring match, deliberately NOT
    // \b-bounded: a \b-bounded pattern does not fire inside a compound
    // PascalCase/camelCase identifier such as `OrdersDb` or
    // `OrdersIdempotentConsumer` (there is no word boundary between two
    // adjacent letters regardless of case), which is exactly the failure
    // mode this case exists to catch — "it fails the day someone writes
    // OrdersDb ... into the pattern" (design.md §6.4). None of the
    // canonical pair's genuine vocabulary (recordProcessedEvent,
    // processedEvents, coordinator-free prose, etc.) contains any of these
    // five strings as a substring, so this is not a false-positive risk
    // for the content these files actually carry.
    const forbiddenServiceName = /orders|fulfillment|billing|projector|notifications/i;

    expect(canonicalConsumerBody, 'idempotent-consumer.ts names a service outside its banner').not.toMatch(
      forbiddenServiceName,
    );
    expect(canonicalRepoBody, 'processed-events.repository.ts names a service outside its banner').not.toMatch(
      forbiddenServiceName,
    );

    const specifiers = [...importSpecifiersOf(canonicalConsumerBody), ...importSpecifiersOf(canonicalRepoBody)];
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(PORTABLE_IMPORT_WHITELIST, `import "${specifier}" is not in the portable whitelist`).toContain(
        specifier,
      );
    }
  });

  it('requires a copy of the pattern from every write model that consumes facts', () => {
    const violations = listApps().filter(
      (app) =>
        hasMySqlProcessedEventsSchema(app) &&
        hasEventPatternHandler(app) &&
        !existsSync(idempotentConsumerPathOf(app)),
    );

    expect(
      violations,
      `app(s) with a MySQL processed_events schema and an @EventPattern handler but no idempotent-consumer.ts copy: ${violations.join(', ')}`,
    ).toEqual([]);
  });

  it('requires a documented divergence banner from a copy that cannot share the canonical\'s transaction', () => {
    const variantPaths = listApps()
      .filter((app) => !hasMySqlProcessedEventsSchema(app))
      .map((app) => idempotentConsumerPathOf(app))
      .filter((candidate) => existsSync(candidate));

    // Dormant today (no such file exists) — arms at features 23/24 (the
    // projector's MongoDB ledger, notifications' choice of store).
    for (const variantPath of variantPaths) {
      const banner = bannerOf(readFileSync(variantPath, 'utf8'));
      expect(banner, `${variantPath}: a variant's banner must cite the canonical path`).toContain(
        CANONICAL_PATH_LITERAL,
      );
      expect(banner, `${variantPath}: a variant's banner must carry a "Divergence:" line`).toMatch(/Divergence:/);
    }
  });
});
