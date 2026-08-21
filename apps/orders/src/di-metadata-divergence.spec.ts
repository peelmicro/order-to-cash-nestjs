// DI-metadata divergence (review_orders_acceptance.md §12, cross-cutting
// item folded into this feature's fix pass): `tsconfig.base.json` sets
// `emitDecoratorMetadata: true`, so `pnpm build` (`tsc`) emits
// `design:paramtypes` for a class's constructor parameters — but the OLD
// `dev` script (`tsx watch`, esbuild-based) does NOT implement that
// compiler option, so a provider using BARE-TYPE constructor injection (no
// `@Inject(TOKEN)`) resolved correctly under `pnpm start` and silently
// resolved to `undefined` under `pnpm dev:*`. Feature 16 (`@nestjs/cqrs`)
// is the first DI graph in this repository where bare-type injection is
// the idiom, so this had to close before it starts.
//
// Proved here against TWO REAL child processes running the SAME source
// (`test-support/di-metadata-probe.ts`) through two different compilers —
// not asserted from documentation:
//   - `tsx` (esbuild) — the OLD dev script's compiler. Expected (and
//     reproduced) to resolve the dependency to `undefined`.
//   - `tsc`, with the exact `emitDecoratorMetadata`/`experimentalDecorators`
//     settings `tsconfig.base.json` gives every service — the compiler the
//     FIXED `dev` script (`tsc-watch`, all six `apps/*/package.json`) now
//     runs under the hood. Expected (and reproduced) to resolve correctly.
// `tsc-watch` itself is a thin watch/restart wrapper around this exact
// `tsc` invocation (verified manually: `tsc-watch -p tsconfig.json
// --onSuccess "node ... di-metadata-probe.js"` prints the same
// `DI_RESULT:DEPENDENCY_RESOLVED` line as the direct `tsc` compile below —
// not re-asserted here as a spec because a full-project watch build is
// too slow for the fast `pnpm test` gate; a single-file `tsc` compile with
// the same compiler flags isolates exactly the fix without that cost).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ORDERS_ROOT = path.resolve(__dirname, '..');
const TSX_BIN = path.resolve(ORDERS_ROOT, 'node_modules/.bin/tsx');
const TSC_BIN = path.resolve(ORDERS_ROOT, 'node_modules/.bin/tsc');
const PROBE_SOURCE = path.resolve(__dirname, 'test-support/di-metadata-probe.ts');

let outDir: string | undefined;

afterEach(() => {
  if (outDir) {
    rmSync(outDir, { recursive: true, force: true });
    outDir = undefined;
  }
});

describe('DI-metadata divergence (review_orders_acceptance.md §12)', () => {
  it('tsx (the OLD dev script compiler) resolves bare-type constructor injection to undefined', () => {
    const output = execFileSync(TSX_BIN, [PROBE_SOURCE], { cwd: ORDERS_ROOT, encoding: 'utf8', timeout: 30_000 });

    expect(output).toContain('DI_RESULT:DEPENDENCY_UNDEFINED');
  }, 30_000);

  it('tsc with emitDecoratorMetadata (the compiler the FIXED tsc-watch dev script uses) resolves bare-type constructor injection correctly', () => {
    outDir = mkdtempSync(path.join(tmpdir(), 'otc-di-metadata-'));

    // The same compiler options `tsconfig.base.json` gives every service
    // (target/module/moduleResolution match tsconfig.base.json;
    // experimentalDecorators + emitDecoratorMetadata are the two flags
    // this whole regression is actually about).
    execFileSync(
      TSC_BIN,
      [
        '--target', 'ES2023',
        '--module', 'NodeNext',
        '--moduleResolution', 'NodeNext',
        '--experimentalDecorators',
        '--emitDecoratorMetadata',
        '--esModuleInterop',
        '--skipLibCheck',
        '--outDir', outDir,
        PROBE_SOURCE,
      ],
      { cwd: ORDERS_ROOT, timeout: 30_000 },
    );
    const output = execFileSync('node', [path.join(outDir, 'di-metadata-probe.js')], {
      cwd: ORDERS_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(output).toContain('DI_RESULT:DEPENDENCY_RESOLVED');
  }, 30_000);
});
