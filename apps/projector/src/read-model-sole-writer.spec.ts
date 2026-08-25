// PR20 › the projector is the only RUNTIME WRITER of `order_timeline` (R54).
// A mongodb import alone is not the violation — feature 25 gave
// `apps/gateway` a legitimate, read-only `mongodb` import (R54's OTHER
// half: order list/detail queries must be served from the read model), and
// a guard that flagged every importer would report the gateway as an
// offender for doing exactly what R54 requires. So this guard tests WHO
// WRITES, not who imports: any app other than the allow-listed `apps/seed`
// (an offline fixture loader, never deployed, run BEFORE the system runs,
// writing documents in exactly the shape this feature specifies — design.md
// §9.4, requirements.md PR20) that invokes a MongoDB WRITE operation in its
// production source is the violation. `apps/projector` itself is the
// writer this whole feature exists to build and is permitted unconditionally.
//
// Detection: a source-level scan for the driver's write-shaped method-call
// INVOCATIONS (`.insertOne(`, `.updateOne(`, ...) — the same "invocation
// shape, not the bare word" discipline every structural guard in this repo
// uses (billing-consumes-no-facts.spec.ts's `.producer(`/`.consumer(`,
// notifications-consumes-only.spec.ts's `@MessagePattern(`). This is
// deliberately NOT a substring match on `mongodb` or on any single method
// name in isolation — Phase 11's OI12 affair (N5) and the gateway review's
// finding F2 (a `grep` for `'mysql2'` that missed the `'mysql2/promise'`
// form every service in this repo actually uses) are exactly the failure
// mode a narrow, author-imagined pattern produces. The write-method list
// below is the FULL surface of `mongodb`'s `Collection`/`Db` mutating API
// (insert/update/replace/delete/findOneAnd*/bulkWrite/index and
// collection/database DDL), not just the one or two forms a first draft
// happens to think of, and this file's own test armes five of the riskiest
// forms individually (`insertOne`, `updateOne`, `findOneAndUpdate`,
// `bulkWrite`, `deleteMany`) rather than trusting the list once.
//
// Known, stated limitation (honesty over false confidence): this is a
// TEXT scan, not a type-level or driver-level check. It cannot bind a
// `.updateOne(` call to a value that actually originated from a `mongodb`
// import — a file that imports `mongodb` AND happens to call an unrelated
// method of the same name on a different object would be a false positive
// (accepted here, same residual risk every other invocation-shape guard in
// this repo already carries), and a $merge/$out stage inside an
// `.aggregate(` pipeline (which technically writes) would be a FALSE
// NEGATIVE this guard cannot see (no service in this repo uses that shape
// today). A stronger version would type-check which methods are invoked on
// values statically typed `Collection<T>`/`Db` (via the TypeScript compiler
// API) or assert at runtime that the driver connection is opened
// read-only/`readOnly: true` where the driver supports it — both are
// heavier than this repo's existing structural-guard convention justifies
// today; flagged here for whoever revisits this if the residual risk above
// is ever exercised for real.
//
// Test-only Mongo writes (a service's OWN integration spec inserting a
// fixture document directly, to test its OWN read path — apps/gateway does
// exactly this) are NOT production writes and are excluded from the scan,
// the same "test-support/ and *.spec.ts are a different category" rule
// notifications-consumes-only.spec.ts's `collectSourceFiles` already
// applies.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const APPS_ROOT = path.join(REPO_ROOT, 'apps');
/** The one stated exception, and why — see this file's header. `apps/projector` is the writer this feature builds and is permitted unconditionally, checked separately below. */
const ALLOW_LISTED_WRITERS = ['seed'];
const MONGODB_VALUE_IMPORT = /from ['"]mongodb['"]/;

/**
 * The full write-shaped surface of `mongodb`'s `Collection`/`Db` API —
 * every mutating operation the driver exposes, not a curated subset. The
 * invocation shape (`.name(`) is required, exactly like every other
 * structural guard in this repo, so a comment or an unrelated identifier
 * naming the same word in prose is never a false positive.
 */
const WRITE_METHOD_NAMES = [
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'findAndModify',
  'bulkWrite',
  'initializeOrderedBulkOp',
  'initializeUnorderedBulkOp',
  'createIndex',
  'createIndexes',
  'dropIndex',
  'dropIndexes',
  'createCollection',
  'dropCollection',
  'dropDatabase',
  'renameCollection',
  'drop',
];
const WRITE_METHOD_CALL = new RegExp(`\\.(${WRITE_METHOD_NAMES.join('|')})\\(`);

interface SourceFile {
  readonly relativePath: string;
  readonly content: string;
}

/** Every production `.ts` source file under `apps/<app>/src` — `test-support/` and `*.spec.ts` are a DIFFERENT category (a service's own integration spec seeding a fixture directly into ITS OWN read model, e.g. apps/gateway's, is not a production write) and are excluded, same as every other structural guard in this repo. */
function productionSourceFiles(app: string): SourceFile[] {
  const srcDir = path.join(APPS_ROOT, app, 'src');
  if (!existsSync(srcDir)) return [];
  const files: SourceFile[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const absolutePath = path.join(dir, entry);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'test-support') continue;
        walk(absolutePath);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) continue;
      files.push({ relativePath: path.relative(srcDir, absolutePath), content: readFileSync(absolutePath, 'utf8') });
    }
  }

  walk(srcDir);
  return files;
}

function listApps(): string[] {
  return readdirSync(APPS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** Apps whose PRODUCTION source imports `mongodb` at all (readers and writers both) — informational/non-vacuity only; NOT the guard's actual assertion (see header). */
function appsImportingMongodb(): string[] {
  return listApps().filter((app) => productionSourceFiles(app).some((file) => MONGODB_VALUE_IMPORT.test(file.content)));
}

/** Apps whose PRODUCTION source invokes a MongoDB WRITE operation — this IS the guard's actual assertion. */
function appsWritingToMongodb(): string[] {
  return listApps().filter((app) => productionSourceFiles(app).some((file) => WRITE_METHOD_CALL.test(file.content)));
}

describe('read-model-sole-writer — PR20 (tests WHO WRITES, not who imports — R54)', () => {
  it('permits a MongoDB WRITE operation in apps/projector (the writer this feature builds) and the allow-listed apps/seed only', () => {
    const writers = appsWritingToMongodb().filter((app) => app !== 'projector' && !ALLOW_LISTED_WRITERS.includes(app));

    expect(
      writers,
      `unexpected MongoDB writer(s): ${writers.join(', ')} — R54 makes the projector the sole runtime writer`,
    ).toEqual([]);

    // Non-vacuity: projector and seed genuinely DO write (the scan is not
    // accidentally matching nothing).
    expect(appsWritingToMongodb().sort()).toEqual(['projector', 'seed']);
  });

  it('permits a mongodb IMPORT anywhere R54 allows a reader — a read-only importer is not flagged', () => {
    // apps/gateway imports mongodb to serve R54's OTHER half (list/detail
    // queries from the read model) and must NOT be reported here — only
    // whether it also WRITES matters, and G1 below proves it does not.
    const importers = appsImportingMongodb();
    const writers = appsWritingToMongodb();
    const readOnlyImporters = importers.filter((app) => !writers.includes(app));

    // Non-vacuity: at least one app imports mongodb without writing to it —
    // proves this case is not vacuously true because nobody imports it.
    expect(readOnlyImporters.length).toBeGreaterThan(0);
    // None of the read-only importers are reported as offenders by the
    // actual guard assertion above (restated here for this case's own
    // clarity, independent of the writer-only test).
    for (const app of readOnlyImporters) {
      expect(app === 'projector' || app === 'seed' || !appsWritingToMongodb().includes(app)).toBe(true);
    }
  });

  describe('non-vacuity — a temporary fixture in a THIRD app (never allow-listed, never the projector)', () => {
    const thirdApp = 'notifications';
    const fixtureDir = path.join(APPS_ROOT, thirdApp, 'src');
    const fixtureFile = path.join(fixtureDir, '__pr20-fixture-mongodb.ts');

    afterEach(() => {
      if (existsSync(fixtureFile)) {
        rmSync(fixtureFile);
      }
    });

    function writeFixture(body: string): void {
      mkdirSync(fixtureDir, { recursive: true });
      writeFileSync(fixtureFile, `import type { Collection } from 'mongodb';\nexport async function fixture(collection: Collection): Promise<unknown> {\n  return ${body};\n}\n`);
    }

    it('a READER (find/findOne only) in a third app PASSES — it is not reported as a writer', () => {
      writeFixture("collection.findOne({ _id: 'x' } as never)");

      const writers = appsWritingToMongodb().filter((app) => app !== 'projector' && !ALLOW_LISTED_WRITERS.includes(app));

      expect(writers).not.toContain(thirdApp);
    });

    it.each([
      ['insertOne', "collection.insertOne({ _id: 'x' } as never)"],
      ['updateOne', "collection.updateOne({ _id: 'x' } as never, { $set: { a: 1 } } as never)"],
      ['findOneAndUpdate', "collection.findOneAndUpdate({ _id: 'x' } as never, { $set: { a: 1 } } as never)"],
      ['bulkWrite', 'collection.bulkWrite([] as never)'],
      ['deleteMany', 'collection.deleteMany({} as never)'],
    ])('a WRITER (%s) in a third app FAILS — it is reported as an unexpected writer', (_label, body) => {
      writeFixture(body);

      const writers = appsWritingToMongodb().filter((app) => app !== 'projector' && !ALLOW_LISTED_WRITERS.includes(app));

      expect(writers).toContain(thirdApp);
    });
  });
});
