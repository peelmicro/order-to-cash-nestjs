// N2 — the DI-metadata divergence guard. Prevents regression of the tsx/esbuild
// compiler split that was discovered in feature 15 (review_orders_acceptance.md
// §12). The hazard: `tsconfig.base.json` emits `design:paramtypes` metadata
// (required for Nest's bare-type constructor injection), but `tsx` (esbuild)
// does not, while `tsc-watch` does. When dev and prod compilers differ,
// a service builds and boots fine under `pnpm dev`, silently injects `undefined`
// for bare-type parameters, and only fails on the first use (or at `pnpm start`).
//
// This guard prevents silent reversion by checking:
// (a) `tsconfig.base.json` has BOTH `emitDecoratorMetadata: true` AND
//     `experimentalDecorators: true` — if either is off, the build loses metadata
// (b) every `apps/*/package.json` with a `dev` script uses `tsc-watch` (never
//     `tsx watch`) — if this reverts, the dev compiler no longer emits metadata
//
// Pure text/JSON, no Docker, no framework: runs inside `pnpm quality`.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (readdirSync(dir).includes('pnpm-workspace.yaml')) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`di-metadata-guard.spec: could not find pnpm-workspace.yaml walking up from ${startDir}`);
    }
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(__dirname);

// The six NestJS services that use the DI metadata convention.
// apps/web (Nuxt) and apps/seed (CLI) are exempt: they do not use @nestjs/core
// dependency injection and their dev scripts reflect different runtime requirements.
const NESTJS_SERVICES = ['orders', 'fulfillment', 'billing', 'gateway', 'notifications', 'projector'] as const;

function loadJsonFile<T>(filePath: string): T {
  const content = readFileSync(filePath, 'utf8');
  return JSON.parse(content);
}

describe('di-metadata-guard — N2', () => {
  it('asserts tsconfig.base.json has emitDecoratorMetadata: true', () => {
    const tsconfigPath = path.join(REPO_ROOT, 'tsconfig.base.json');
    const tsconfig = loadJsonFile<{ compilerOptions?: { emitDecoratorMetadata?: boolean } }>(tsconfigPath);

    expect(tsconfig.compilerOptions?.emitDecoratorMetadata, 'tsconfig.base.json must have emitDecoratorMetadata: true').toBe(
      true,
    );
  });

  it('asserts tsconfig.base.json has experimentalDecorators: true', () => {
    const tsconfigPath = path.join(REPO_ROOT, 'tsconfig.base.json');
    const tsconfig = loadJsonFile<{ compilerOptions?: { experimentalDecorators?: boolean } }>(tsconfigPath);

    expect(tsconfig.compilerOptions?.experimentalDecorators, 'tsconfig.base.json must have experimentalDecorators: true').toBe(
      true,
    );
  });

  it('asserts every NestJS service dev script uses tsc-watch, not tsx watch', () => {
    // Non-vacuity: all six services have a dev script
    expect(NESTJS_SERVICES.length, 'should have NestJS services to check').toBeGreaterThan(0);

    // Validate every NestJS service's dev script uses tsc-watch, not tsx watch
    for (const app of NESTJS_SERVICES) {
      const pkgJsonPath = path.join(REPO_ROOT, 'apps', app, 'package.json');
      const pkg = loadJsonFile<{ scripts?: Record<string, string> }>(pkgJsonPath);
      const devScript = pkg.scripts?.dev;

      expect(devScript, `apps/${app}/package.json dev script must exist`).toBeDefined();
      expect(devScript, `apps/${app}/package.json dev script must use tsc-watch, not tsx watch`).toContain('tsc-watch');
      expect(devScript, `apps/${app}/package.json dev script must not use tsx watch`).not.toMatch(/tsx\s+watch/);
    }
  });
});
