// PR20 › permits a mongodb import in apps/projector and the allow-listed
// apps/seed only, and genuinely fires on a temporary fixture in a third
// app. `apps/seed` is allow-listed BY NAME, with its reason stated right
// here: it is an offline fixture loader, never deployed, run BEFORE the
// system runs, writing documents in exactly the shape this feature
// specifies (design.md §9.4, requirements.md PR20). The guard's value is
// that a FOURTH writer cannot appear quietly.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const APPS_ROOT = path.join(REPO_ROOT, 'apps');
/** The one stated exception, and why — see this file's header. */
const ALLOW_LISTED_MONGODB_IMPORTERS = ['projector', 'seed'];
const MONGODB_VALUE_IMPORT = /from ['"]mongodb['"]/;

function listApps(): string[] {
  return readdirSync(APPS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function appsImportingMongodb(): string[] {
  const offenders: string[] = [];
  for (const app of listApps()) {
    const srcDir = path.join(APPS_ROOT, app, 'src');
    if (!existsSync(srcDir)) continue;
    if (walkForMongodbImport(srcDir)) {
      offenders.push(app);
    }
  }
  return offenders;
}

function walkForMongodbImport(dir: string): boolean {
  for (const entry of readdirSync(dir)) {
    const absolutePath = path.join(dir, entry);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      if (walkForMongodbImport(absolutePath)) return true;
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (MONGODB_VALUE_IMPORT.test(readFileSync(absolutePath, 'utf8'))) {
      return true;
    }
  }
  return false;
}

describe('read-model-sole-writer — PR20', () => {
  it('permits a mongodb import in apps/projector and apps/seed only', () => {
    const offenders = appsImportingMongodb().filter((app) => !ALLOW_LISTED_MONGODB_IMPORTERS.includes(app));

    expect(offenders, `unexpected mongodb importer(s): ${offenders.join(', ')} — R54 makes the projector the sole runtime writer`).toEqual([]);
    // Non-vacuity: the allow-listed apps genuinely DO import mongodb (the
    // scan is not accidentally matching nothing).
    expect(appsImportingMongodb().sort()).toEqual([...ALLOW_LISTED_MONGODB_IMPORTERS].sort());
  });

  describe('non-vacuity — a temporary fixture in a THIRD app', () => {
    const thirdApp = 'notifications';
    const fixtureFile = path.join(APPS_ROOT, thirdApp, 'src', '__pr20-fixture-mongodb-import.ts');

    afterEach(() => {
      if (existsSync(fixtureFile)) {
        rmSync(fixtureFile);
      }
    });

    it('genuinely fires when a THIRD app (never allow-listed) acquires a mongodb import', () => {
      mkdirSync(path.dirname(fixtureFile), { recursive: true });
      writeFileSync(fixtureFile, "import { MongoClient } from 'mongodb';\nexport const client = new MongoClient('mongodb://x');\n");

      const offenders = appsImportingMongodb().filter((app) => !ALLOW_LISTED_MONGODB_IMPORTERS.includes(app));

      expect(offenders).toContain(thirdApp);
    });
  });
});
