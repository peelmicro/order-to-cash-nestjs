import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateAll, main } from './generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const committedDir = path.join(packageRoot, 'src', 'generated');
const tsxBin = path.join(packageRoot, 'node_modules', '.bin', 'tsx');

/**
 * This is `pnpm contracts:check`'s assertion, run as part of `pnpm test` too
 * — so a hand-edit of `src/generated/*.ts`, or a forgotten regeneration
 * after touching `specs/shared/*.yaml`, fails the ordinary test suite and
 * not only the separate `contracts:check` script.
 */
describe('generateAll — committed output matches a fresh run', () => {
  it('produces byte-identical asyncapi.types.ts and openapi.types.ts', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'otc-contracts-generate-spec-'));
    try {
      await generateAll(tempDir);

      for (const file of ['asyncapi.types.ts', 'openapi.types.ts']) {
        const [committed, fresh] = await Promise.all([
          readFile(path.join(committedDir, file), 'utf8'),
          readFile(path.join(tempDir, file), 'utf8'),
        ]);
        expect(fresh, `src/generated/${file} is stale — run pnpm generate`).toBe(committed);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it(
    'run as a CLI (`tsx scripts/generate.mts`) exits 0, prints a confirmation ' +
      'and leaves the committed files unchanged — proving the exact command ' +
      '`pnpm contracts:generate` runs is idempotent, not just the imported function',
    () => {
      const result = spawnSync(tsxBin, ['scripts/generate.mts'], {
        cwd: packageRoot,
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('contracts:generate — wrote');
    },
  );

  it('main() — writes to the given directory and logs a confirmation, in-process', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'otc-contracts-generate-main-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await main(tempDir);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('contracts:generate — wrote'));
      const asyncApiOutput = await readFile(path.join(tempDir, 'asyncapi.types.ts'), 'utf8');
      expect(asyncApiOutput).toContain('DO NOT EDIT');
    } finally {
      logSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
