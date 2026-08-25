// G5 (progress/review_gateway_rest_auth.md Round 2) — the parity guard for
// the per-service copies of the bare-JSON NATS wire pair, in the same shape
// `idempotent-consumer.parity.spec.ts` (OI12) already established for the
// MySQL write models' idempotent-consumer pair. Pure text/fs: `node:fs` +
// `readdirSync('apps')` only, repo root resolved the same way OI12 does —
// no glob package, no new dependency, no Docker, so this runs inside
// `pnpm quality`.
//
// The canonical pair is `apps/fulfillment/src/infrastructure/messaging/
// bare-json-nats.{deserializer,serializer}.ts` — the first service to write
// it (F1's finding: it predates the "COPY OF" banner convention, which
// billing introduced when it copied the pair, and which orders' own copy
// follows too). Every other NATS RPC responder's copy must be byte-
// identical to the canonical after ONE normalisation: the leading
// comment block (the file's contiguous run of `//` lines from the top —
// EVERY service's copy opens with one, whether or not it carries a
// "COPY OF" line) is stripped from both sides first, exactly as OI12
// strips `idempotent-consumer.ts`'s banner. This is NOT a "does the file
// mention X" substring scan (the Phase 11 OI12 failure, repeated as F2 in
// this very feature) — it is a full-body equality check on everything
// AFTER the header comment: the imports, the class, every method body. A
// single-character change anywhere in the executable code — not just a
// changed comment — fails this test and names the diverging service. Proven
// by execution below (see this file's own header note on arming) and
// recorded verbatim in progress/impl_orders_bare_json_wire.md.
//
// Byte-identity is deliberately NOT paired with a Docker-free behavioural
// harness the way OI12 grew one (the FileBackedIdempotentConsumer block) —
// that extra layer exists in OI12 because ITS original discriminator was a
// prose "Divergence:" comment nobody validated, so a copy could gut its own
// dedup logic and still pass on text alone. Here, each copy already OWNS a
// real, RUNNING unit spec (`bare-json-nats.spec.ts`, present in every
// 'nats-bare-json-copy' service) that drives `BareJsonNatsDeserializer`/
// `BareJsonNatsSerializer` through the ACTUAL `@nestjs/microservices`
// `ServerNats` call shape and asserts the real wire behaviour (synthetic id
// assignment, event-vs-request branching, bare-reply framing, the
// `RpcError` shape) — not a text match. Byte-identity of the PRODUCTION
// file to the canonical is therefore sufficient to transfer that
// already-proven behaviour to every copy: if the canonical is correct
// (proven by its own spec) and a copy is byte-identical to it (proven
// here), the copy is correct by construction, with no separate reference
// implementation needed. `bare-json-nats.spec.ts` itself is deliberately
// OUT of this guard's scope — OI12 does not parity-check
// `idempotent-consumer.spec.ts` either, only the production pair; a spec
// file is allowed to phrase its own example subjects however is clearest
// for that service (this file's own copy uses 'orders.create' as its
// example channel where fulfillment's/billing's use
// 'fulfillment.stock.check' — a readability choice, not a behavioural one).
//
// --- The discriminator, self-validating from the start (G5's own demand,
// citing OI12's post-N5 amendment) ---------------------------------------
// `SERVICE_BARE_JSON_MODE` below is a registry, but it is CHECKED against
// the filesystem, not trusted: `requires every app to be accounted for in
// the bare-JSON wire mode registry` fails LOUDLY the moment `readdirSync
// ('apps')` returns a name this file does not know, and `keeps the
// registry honest against what is actually on disk` fails LOUDLY the
// moment a registered mode disagrees with what is actually there — a
// 'nats-bare-json-copy' entry missing either file, or with no NATS
// `@MessagePattern` handler to justify owning the pair at all; a
// 'no-nats-responder' entry that has grown one. An app cannot silently
// exempt itself from this guard by never creating the files, the way OI12's
// pre-N5 filesystem-only discriminator allowed.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `apps/*` directory MUST have an entry here (enforced below).
 *
 * - `'nats-bare-json-copy'` — owns (or is) the byte-identical canonical
 *                             `bare-json-nats.deserializer.ts` +
 *                             `bare-json-nats.serializer.ts` pair, AND owns
 *                             at least one `@MessagePattern(..., Transport
 *                             .NATS)` responder the pair exists to serve.
 * - `'no-nats-responder'`   — has no NATS `@MessagePattern` responder at
 *                             all today (a Kafka-only consumer, a REST
 *                             façade, a seeding script, the web app). Must
 *                             own neither file of the pair.
 */
const SERVICE_BARE_JSON_MODE: Record<string, 'nats-bare-json-copy' | 'no-nats-responder'> = {
  orders: 'nats-bare-json-copy',
  fulfillment: 'nats-bare-json-copy',
  billing: 'nats-bare-json-copy',
  notifications: 'no-nats-responder',
  projector: 'no-nats-responder',
  gateway: 'no-nats-responder',
  seed: 'no-nats-responder',
  web: 'no-nats-responder',
};

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`bare-json-nats.parity: could not find pnpm-workspace.yaml walking up from ${startDir}`);
    }
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(__dirname);
const CANONICAL_DESERIALIZER_PATH_LITERAL = 'apps/fulfillment/src/infrastructure/messaging/bare-json-nats.deserializer.ts';
const CANONICAL_SERIALIZER_PATH_LITERAL = 'apps/fulfillment/src/infrastructure/messaging/bare-json-nats.serializer.ts';
const CANONICAL_DESERIALIZER_PATH = path.join(REPO_ROOT, CANONICAL_DESERIALIZER_PATH_LITERAL);
const CANONICAL_SERIALIZER_PATH = path.join(REPO_ROOT, CANONICAL_SERIALIZER_PATH_LITERAL);

/** Every specifier the canonical pair imports today — no relative path in either file, unlike idempotent-consumer.ts's pair, so the whitelist is just the portable package/builtin surface. */
const PORTABLE_IMPORT_WHITELIST = [
  'reflect-metadata',
  'node:crypto',
  '@nestjs/microservices/deserializers/nats-request-json.deserializer',
  '@nestjs/microservices',
  'nats',
  '@otc/contracts',
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

/**
 * A real `@MessagePattern(..., Transport.NATS)` decorator use — the whole
 * point of owning the bare-JSON pair. `.spec.ts` files are excluded from
 * the walk: `apps/notifications/src/notifications-consumes-only.spec.ts`
 * and `apps/projector/src/projector-consumes-only.spec.ts` (guards for a
 * DIFFERENT feature, proving those services never register one) each embed
 * the literal string `"@MessagePattern('orders.create', Transport.NATS)"`
 * as a FIXTURE — text their own guard feeds itself to prove its own
 * detector fires — and a naive text scan over ALL `.ts` files matches that
 * fixture string as if it were a real decorator. Production responders live
 * exclusively under `presentation/`, never inside a `*.spec.ts` file, so
 * excluding specs removes the false positive without weakening the real
 * signal (proven by this guard's own registry-honesty test, which failed
 * loudly against exactly this false positive before this exclusion was
 * added — see progress/impl_orders_bare_json_wire.md for the verbatim
 * failure this fix corrects).
 */
function hasNatsMessagePatternHandler(app: string): boolean {
  const srcDir = path.join(REPO_ROOT, 'apps', app, 'src');
  return walkTsFiles(srcDir)
    .filter((file) => !file.endsWith('.spec.ts'))
    .some((file) => /@MessagePattern\([^)]*\bTransport\.NATS\b[^)]*\)/.test(readFileSync(file, 'utf8')));
}

function bareJsonDeserializerPathOf(app: string): string {
  return path.join(REPO_ROOT, 'apps', app, 'src/infrastructure/messaging/bare-json-nats.deserializer.ts');
}

function bareJsonSerializerPathOf(app: string): string {
  return path.join(REPO_ROOT, 'apps', app, 'src/infrastructure/messaging/bare-json-nats.serializer.ts');
}

describe('bare-json-nats.parity — G5', () => {
  const canonicalDeserializerText = readFileSync(CANONICAL_DESERIALIZER_PATH, 'utf8');
  const canonicalSerializerText = readFileSync(CANONICAL_SERIALIZER_PATH, 'utf8');
  const canonicalDeserializerBody = stripBanner(canonicalDeserializerText);
  const canonicalSerializerBody = stripBanner(canonicalSerializerText);

  it('requires every app to be accounted for in the bare-JSON wire mode registry (no silent exemption by omission)', () => {
    const unregistered = listApps().filter((app) => !(app in SERVICE_BARE_JSON_MODE));

    expect(
      unregistered,
      `app(s) present under apps/ but missing from SERVICE_BARE_JSON_MODE in this file: ${unregistered.join(', ')} — add an entry before this can pass`,
    ).toEqual([]);
  });

  it('keeps the bare-JSON wire mode registry honest against what is actually on disk', () => {
    const violations: string[] = [];
    for (const [app, mode] of Object.entries(SERVICE_BARE_JSON_MODE)) {
      if (!listApps().includes(app)) {
        violations.push(`${app}: registered as '${mode}' but apps/${app} does not exist`);
        continue;
      }
      const hasHandler = hasNatsMessagePatternHandler(app);
      const hasDeserializer = existsSync(bareJsonDeserializerPathOf(app));
      const hasSerializer = existsSync(bareJsonSerializerPathOf(app));

      if (mode === 'nats-bare-json-copy') {
        if (!hasDeserializer) {
          violations.push(`${app}: registered 'nats-bare-json-copy' but owns no bare-json-nats.deserializer.ts`);
        }
        if (!hasSerializer) {
          violations.push(`${app}: registered 'nats-bare-json-copy' but owns no bare-json-nats.serializer.ts`);
        }
        if (!hasHandler) {
          violations.push(
            `${app}: registered 'nats-bare-json-copy' but has no @MessagePattern(..., Transport.NATS) handler — nothing to answer over this wire`,
          );
        }
      }
      if (mode === 'no-nats-responder') {
        if (hasHandler) {
          violations.push(
            `${app}: registered 'no-nats-responder' but has grown an @MessagePattern(..., Transport.NATS) handler — promote it to 'nats-bare-json-copy' and add the wire pair`,
          );
        }
        if (hasDeserializer || hasSerializer) {
          violations.push(`${app}: registered 'no-nats-responder' but owns a bare-json-nats copy with nothing to justify it`);
        }
      }
    }

    expect(violations, violations.join('; ')).toEqual([]);
  });

  it('holds every NATS responder\'s copy of the bare-JSON wire pair byte-identical to the canonical (apps/fulfillment) copy', () => {
    const copies = listApps().filter(
      (app) =>
        SERVICE_BARE_JSON_MODE[app] === 'nats-bare-json-copy' &&
        existsSync(bareJsonDeserializerPathOf(app)) &&
        existsSync(bareJsonSerializerPathOf(app)),
    );

    // Non-vacuity: the canonical (fulfillment) is always a member of its own
    // set, and today orders and billing must be too.
    expect(copies).toContain('fulfillment');
    expect(copies).toContain('billing');
    expect(copies).toContain('orders');

    for (const app of copies) {
      const deserializerBody = stripBanner(readFileSync(bareJsonDeserializerPathOf(app), 'utf8'));
      const serializerBody = stripBanner(readFileSync(bareJsonSerializerPathOf(app), 'utf8'));
      expect(
        deserializerBody,
        `apps/${app}'s bare-json-nats.deserializer.ts diverges from the canonical apps/fulfillment copy (banner-stripped)`,
      ).toBe(canonicalDeserializerBody);
      expect(
        serializerBody,
        `apps/${app}'s bare-json-nats.serializer.ts diverges from the canonical apps/fulfillment copy (banner-stripped)`,
      ).toBe(canonicalSerializerBody);
    }
  });

  it('keeps the canonical pair adoptable verbatim, naming no service and importing nothing service-specific', () => {
    // Deliberately NOT \b-bounded — see idempotent-consumer.parity.spec.ts's
    // own header note on why a \b-bounded pattern misses compound
    // PascalCase/camelCase identifiers. None of this pair's genuine
    // vocabulary contains any of these five strings as a substring.
    const forbiddenServiceName = /orders|fulfillment|billing|projector|notifications/i;

    expect(canonicalDeserializerBody, 'bare-json-nats.deserializer.ts names a service outside its banner').not.toMatch(
      forbiddenServiceName,
    );
    expect(canonicalSerializerBody, 'bare-json-nats.serializer.ts names a service outside its banner').not.toMatch(
      forbiddenServiceName,
    );

    const specifiers = [...importSpecifiersOf(canonicalDeserializerBody), ...importSpecifiersOf(canonicalSerializerBody)];
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(PORTABLE_IMPORT_WHITELIST, `import "${specifier}" is not in the portable whitelist`).toContain(specifier);
    }
  });

  it('requires a copy of the pair from every NATS responder registered nats-bare-json-copy', () => {
    const violations = listApps().filter(
      (app) =>
        SERVICE_BARE_JSON_MODE[app] === 'nats-bare-json-copy' &&
        hasNatsMessagePatternHandler(app) &&
        (!existsSync(bareJsonDeserializerPathOf(app)) || !existsSync(bareJsonSerializerPathOf(app))),
    );

    expect(
      violations,
      `app(s) registered 'nats-bare-json-copy' with a NATS @MessagePattern handler but missing (part of) the bare-JSON pair: ${violations.join(', ')}`,
    ).toEqual([]);
  });
});
