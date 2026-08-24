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
// first.
//
// --- The discriminator (post-N5 amendment) ---------------------------------
// design.md §6.4 originally chose to read "copy vs. variant" purely from
// the filesystem (does the app own a MySQL `processed_events` schema),
// explicitly REJECTING a hand-maintained registry: "a registry that must be
// edited when a copy is added is a registry someone forgets to edit, and
// the drift then hides in the very file that was supposed to reveal it."
// That objection is correct against an UNVALIDATED registry — but it is not
// an argument against a SELF-VALIDATING one, and the reviewer of feature 23
// (N5, progress/review_notifications_service.md) found the concrete cost of
// the filesystem-only version: the presence of `processed-events.schema.ts`
// is a file the implementer chooses whether to create, so a service can
// silently opt itself out of the canonical pattern — and out of case 3's
// "must own the copy" requirement below — simply by not creating one.
//
// `SERVICE_IDEMPOTENCY_MODE` below is a registry, but it is checked, not
// trusted: `requires every app to be accounted for in the idempotency mode
// registry` fails LOUDLY the moment `readdirSync('apps')` returns a name
// this file does not know, and `keeps the idempotency mode registry honest
// against what is actually on disk` fails LOUDLY the moment a registered
// mode disagrees with the filesystem truth it claims (a 'mysql-copy' entry
// with no schema file, a 'no-consumer' entry that grew an `@EventPattern`
// handler, ...). Forgetting to update the registry when a service changes
// shape no longer hides the drift — it turns the very next `pnpm quality`
// red. That is what makes it safe to reintroduce, where design.md's
// objection was to a registry nobody re-checks.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeIdempotentConsumerConformance,
  type ConformableIdempotentConsumer,
} from './test-support/idempotent-consumer-conformance';
import { FileBackedIdempotentConsumer } from './test-support/file-backed-idempotent-consumer.example';

/**
 * Every `apps/*` directory MUST have an entry here (enforced below) —
 * that is the whole point of a self-validating registry.
 *
 * - `'mysql-copy'`      — owns (or is) the byte-identical canonical MySQL
 *                         `idempotent-consumer.ts` + `processed-events.repository.ts`
 *                         pair. Must own `processed-events.schema.ts`.
 * - `'documented-variant'` — consumes facts but cannot share the canonical's
 *                         MySQL transaction (design.md §6.3 — today only the
 *                         projector's future MongoDB ledger). Must NOT own
 *                         `processed-events.schema.ts`; if it owns
 *                         `idempotent-consumer.ts` its banner must document
 *                         the divergence (case 4).
 * - `'no-consumer'`      — consumes no fact at all today (a REST façade, a
 *                         seeding script, the web app). Must have no
 *                         `@EventPattern` handler.
 */
const SERVICE_IDEMPOTENCY_MODE: Record<string, 'mysql-copy' | 'documented-variant' | 'no-consumer'> = {
  orders: 'mysql-copy',
  fulfillment: 'mysql-copy',
  billing: 'mysql-copy',
  notifications: 'mysql-copy',
  projector: 'documented-variant',
  gateway: 'no-consumer',
  seed: 'no-consumer',
  web: 'no-consumer',
};

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

  it('requires every app to be accounted for in the idempotency mode registry (N5 — no silent exemption by omission)', () => {
    const unregistered = listApps().filter((app) => !(app in SERVICE_IDEMPOTENCY_MODE));

    expect(
      unregistered,
      `app(s) present under apps/ but missing from SERVICE_IDEMPOTENCY_MODE in this file: ${unregistered.join(
        ', ',
      )} — add an entry (and, if it consumes facts, the canonical pattern copy) before this can pass`,
    ).toEqual([]);
  });

  it('keeps the idempotency mode registry honest against what is actually on disk', () => {
    const violations: string[] = [];
    for (const [app, mode] of Object.entries(SERVICE_IDEMPOTENCY_MODE)) {
      if (!listApps().includes(app)) {
        // A stale entry for an app that no longer exists is a different
        // failure mode (harmless drift, not a silent exemption) — flagged,
        // not fatal, so this case still fails loudly rather than passing
        // silently for the wrong reason.
        violations.push(`${app}: registered as '${mode}' but apps/${app} does not exist`);
        continue;
      }
      const hasSchema = hasMySqlProcessedEventsSchema(app);
      const hasHandler = hasEventPatternHandler(app);
      if (mode === 'mysql-copy' && !hasSchema) {
        violations.push(`${app}: registered 'mysql-copy' but owns no processed-events.schema.ts`);
      }
      if (mode === 'documented-variant' && hasSchema) {
        violations.push(`${app}: registered 'documented-variant' but owns a MySQL processed-events.schema.ts — this is a copy, not a variant`);
      }
      if (mode === 'no-consumer' && hasHandler) {
        violations.push(`${app}: registered 'no-consumer' but has grown an @EventPattern handler — promote it to 'mysql-copy' or 'documented-variant' and add the pattern`);
      }
    }

    expect(violations, violations.join('; ')).toEqual([]);
  });

  it('holds every write model\'s copy of the idempotent-consumer pattern byte-identical to the canonical copy', () => {
    const copies = listApps().filter(
      (app) => SERVICE_IDEMPOTENCY_MODE[app] === 'mysql-copy' && existsSync(idempotentConsumerPathOf(app)),
    );

    // Non-vacuity: the canonical (orders) is always a member of its own set.
    expect(copies).toContain('orders');

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

  it('requires a copy of the pattern from every write model registered mysql-copy that consumes facts', () => {
    const violations = listApps().filter(
      (app) =>
        SERVICE_IDEMPOTENCY_MODE[app] === 'mysql-copy' &&
        hasEventPatternHandler(app) &&
        !existsSync(idempotentConsumerPathOf(app)),
    );

    expect(
      violations,
      `app(s) registered 'mysql-copy' with an @EventPattern handler but no idempotent-consumer.ts copy: ${violations.join(', ')}`,
    ).toEqual([]);
  });

  it(
    "requires a documented divergence banner, naming an existing behavioural-conformance spec file, from a copy " +
      "that cannot share the canonical's transaction",
    () => {
      const variantPaths = listApps()
        .filter((app) => SERVICE_IDEMPOTENCY_MODE[app] === 'documented-variant')
        .map((app) => idempotentConsumerPathOf(app))
        .filter((candidate) => existsSync(candidate));

      // Dormant today (no such file exists) — arms at feature 24 (the
      // projector's MongoDB ledger). The banner-only checks below are
      // NECESSARY, never SUFFICIENT: they cannot execute another app's
      // code from here (apps/orders may only read, not import, another
      // service's source — see this file's own header note on scope), so
      // the actual behavioural proof for a variant is required to live in
      // that service's OWN integration spec, built by copying
      // `idempotent-consumer-conformance.ts` (see that file's own header)
      // and running it against the variant's real backing store — exactly
      // as `idempotent-consumer.parity.integration.spec.ts` does for the
      // canonical. Requiring the banner to NAME that file, and requiring
      // the named file to actually EXIST on disk, is the one part of that
      // requirement this file can enforce without crossing the app
      // boundary: prose alone ("Divergence: ...") is no longer enough to
      // pass this case, the way it was when N5 was found.
      for (const variantPath of variantPaths) {
        const banner = bannerOf(readFileSync(variantPath, 'utf8'));
        expect(banner, `${variantPath}: a variant's banner must cite the canonical path`).toContain(
          CANONICAL_PATH_LITERAL,
        );
        expect(banner, `${variantPath}: a variant's banner must carry a "Divergence:" line`).toMatch(/Divergence:/);

        const conformanceMatch = banner.match(/Behavioural conformance:\s*(\S+)/);
        expect(
          conformanceMatch,
          `${variantPath}: a variant's banner must carry a "Behavioural conformance: <repo-root-relative path>" line naming its own integration spec that runs it through idempotent-consumer-conformance.ts's suite`,
        ).not.toBeNull();
        const conformancePath = path.join(REPO_ROOT, conformanceMatch![1]!);
        expect(
          existsSync(conformancePath),
          `${variantPath}: banner names "${conformanceMatch![1]}" as its behavioural-conformance spec, but that file does not exist`,
        ).toBe(true);
      }
    },
  );
});

// --- Behavioural conformance, run Docker-free against a reference variant --
//
// The old case 4 above stopped at reading a comment. Fixing ONLY the
// discriminator (so a variant can no longer exempt itself by omitting a
// file) would still leave the guard blind to a `runOnce` that performs no
// deduplication at all, banner untouched — the exact mutation the reviewer
// used to defeat OI12 (N5). This block proves the fix is real: it runs the
// SAME generic suite `idempotent-consumer.parity.integration.spec.ts` runs
// against the canonical over Testcontainers MySQL, here against
// `FileBackedIdempotentConsumer` — a real, durable-across-instances (but
// Docker-free) implementation — so the fast `pnpm quality` gate itself now
// executes real behaviour, not just text, and the suite's own
// non-vacuity is proven without a broker or a database.
describe('idempotent-consumer.parity — OI12 behavioural self-test', () => {
  const storeFile = path.join(tmpdir(), `oi12-conformance-${randomUUID()}`, 'store.json');

  function toConformable(consumer: FileBackedIdempotentConsumer): ConformableIdempotentConsumer {
    return consumer;
  }

  describeIdempotentConsumerConformance('the file-backed reference variant (Docker-free)', {
    createConsumer: () => toConformable(new FileBackedIdempotentConsumer(storeFile)),
    newEventId: () => randomUUID(),
  });
});
