// Group B's own instruction: "No write-database client may be constructed
// anywhere in this service — enforce it with a guard spec, not
// convention." This gateway answers `GET /orders`/`GET /orders/{id}` from
// the projector's read model ONLY (R54); it must never open a MySQL
// connection to Orders', Fulfillment's or Billing's write databases.
//
// Review finding F2 (verbatim): the first cut of assertion #2 here was
// `text.includes("'mysql2'")` — a substring check on the EXACT quoted
// specifier. `import mysql from 'mysql2/promise'` and
// `import { drizzle } from 'drizzle-orm/mysql2'` — the precise forms
// `apps/billing/src/infrastructure/persistence/client.ts`/`migrator.ts`
// use for THEIR OWN write database — do not contain `'mysql2'` or
// `'drizzle-orm'` as substrings, so that check passed green against the
// review's armed mutation. That is the Phase 11 OI12 lesson again: a text
// guard that catches the mutation its author imagined and nothing else.
//
// Fixed by REPLACING the text scan with something that EXECUTES: a real,
// unmodified `node` CHILD PROCESS (`node -e "require.resolve(...)"`, cwd
// = this service's own `src/`), proving Node's genuine CommonJS module
// resolution — the SAME algorithm `node dist/main.js` uses in production
// — cannot resolve either package, in ANY specifier form (bare or
// subpath), under pnpm's strict `node_modules`. This is the SAME provable
// property `tsc` reports as `TS2307` on every `pnpm typecheck` run.
//
// A CHILD PROCESS, not `require.resolve()` called in-process: vitest
// injects its OWN `NODE_PATH` into `process.env` (pointing at
// `node_modules/.pnpm/node_modules`, a broadly hoisted directory it uses
// for its own dependency resolution), and Node's module resolution
// algorithm checks `NODE_PATH` as a legacy fallback — so an in-process
// `require.resolve('mysql2')`, or a child process that INHERITS that
// `NODE_PATH`, both "resolve" `mysql2` even though
// `apps/gateway/node_modules/mysql2` does not exist, while a plain
// `node -e "require.resolve('mysql2')"` run from an ordinary shell (no
// vitest ancestor, no injected `NODE_PATH`) genuinely throws
// `MODULE_NOT_FOUND` for the identical call from the identical `cwd`
// (verified by hand while building this fix). `node dist/main.js` in
// production has no vitest ancestor and therefore no injected
// `NODE_PATH` either. `resolvesInARealNodeProcess` below explicitly
// STRIPS `NODE_PATH` from the child's environment for exactly this
// reason — without that, this guard would be GREEN even when the real,
// shipped process would throw, a false negative worse than the
// substring bug it replaces.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const GATEWAY_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.resolve(__dirname);

const FORBIDDEN_PACKAGES = ['mysql2', 'drizzle-orm'];
const FORBIDDEN_SPECIFIERS = ['mysql2', 'mysql2/promise', 'drizzle-orm', 'drizzle-orm/mysql2'];

/** Spawns a genuine, unpatched `node` process and asks IT to resolve `specifier`, from THIS service's own `src/` — real production module resolution, not vitest's. */
function resolvesInARealNodeProcess(specifier: string): { resolved: boolean; output: string } {
  // `NODE_PATH` is stripped from the child's env — vitest injects its OWN
  // `NODE_PATH` (pointing at `node_modules/.pnpm/node_modules`, a broadly
  // hoisted directory) into `process.env` for its own dependency
  // resolution, and a spawned child inherits it by default. Node's module
  // resolution algorithm checks `NODE_PATH` as a legacy fallback AFTER
  // normal `node_modules` walking, and that hoisted directory genuinely
  // DOES let `mysql2`/`drizzle-orm` resolve — found live while building
  // this guard: an un-stripped child process reported `mysql2` as
  // resolvable, while a plain `node -e` run from an ordinary shell (no
  // vitest ancestor, no injected `NODE_PATH`) correctly threw
  // `MODULE_NOT_FOUND` for the identical `require.resolve('mysql2')`
  // call, from the identical `cwd`. `node dist/main.js` in production has
  // no vitest ancestor and therefore no injected `NODE_PATH` either — an
  // un-stripped check would have been a guard that is GREEN in-suite even
  // though the real, shipped process would throw. Stripping it here is
  // what makes this child process representative of production.
  const { NODE_PATH: _unused, ...envWithoutNodePath } = process.env;
  try {
    const stdout = execFileSync(process.execPath, ['-e', `console.log(require.resolve(${JSON.stringify(specifier)}))`], {
      cwd: SRC_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: envWithoutNodePath,
    });
    return { resolved: true, output: stdout.trim() };
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    return { resolved: false, output: typeof stderr === 'string' ? stderr : (stderr?.toString('utf8') ?? String(error)) };
  }
}

describe('no write-database client anywhere in the gateway (Group B)', () => {
  it('package.json declares no MySQL/Drizzle dependency at all', () => {
    const pkg = JSON.parse(readFileSync(path.join(GATEWAY_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeclared = { ...pkg.dependencies, ...pkg.devDependencies };

    for (const forbidden of FORBIDDEN_PACKAGES) {
      expect(Object.keys(allDeclared)).not.toContain(forbidden);
    }
  });

  it(
    'mysql2 and drizzle-orm cannot be resolved from this service by a REAL node process, in bare OR subpath form',
    () => {
      const offenders: string[] = [];
      for (const specifier of FORBIDDEN_SPECIFIERS) {
        const result = resolvesInARealNodeProcess(specifier);
        if (result.resolved) {
          offenders.push(`"${specifier}" resolved to: ${result.output}`);
        }
      }
      expect(offenders).toEqual([]);
    },
    15_000,
  );

  it('non-vacuity: the SAME real-node-process check DOES resolve a real, declared dependency — proving it is not vacuously always-failing', () => {
    expect(resolvesInARealNodeProcess('mongodb').resolved).toBe(true);
    expect(resolvesInARealNodeProcess('nats').resolved).toBe(true);
  });
});
