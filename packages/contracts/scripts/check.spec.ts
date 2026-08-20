import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkGenerated, main } from './check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const realCommittedDir = path.join(packageRoot, 'src', 'generated');
const tsxBin = path.join(packageRoot, 'node_modules', '.bin', 'tsx');

/**
 * `checkGenerated` is exercised here against **copies** of the committed
 * directory, never the real `src/generated/` in place — a corruption test
 * that mutated the real files in place would race any other test file that
 * also touches them (Vitest runs test files in parallel by default), which
 * is exactly the flake this design avoids.
 */
describe('contracts:check — checkGenerated', () => {
  it('reports ok against the real, up-to-date committed directory', async () => {
    const result = await checkGenerated(realCommittedDir);
    expect(result.ok).toBe(true);
    expect(result.messages.some((m) => m.includes('contracts:check OK'))).toBe(true);
  });

  it('reports drift, names the file and includes a diff, against a corrupted copy', async () => {
    const tempCommittedDir = await mkdtemp(path.join(tmpdir(), 'otc-contracts-check-spec-'));
    try {
      await cp(realCommittedDir, tempCommittedDir, { recursive: true });
      await writeFile(
        path.join(tempCommittedDir, 'asyncapi.types.ts'),
        '// hand-edited drift — this file no longer matches the generator output\n',
      );

      const result = await checkGenerated(tempCommittedDir);

      expect(result.ok).toBe(false);
      const joined = result.messages.join('\n');
      expect(joined).toContain('DRIFT');
      expect(joined).toContain('asyncapi.types.ts');
      expect(joined).toContain('contracts:check FAILED');
    } finally {
      await rm(tempCommittedDir, { recursive: true, force: true });
    }
  });

  it('reports drift when a generated file is missing entirely from the committed directory', async () => {
    const tempCommittedDir = await mkdtemp(path.join(tmpdir(), 'otc-contracts-check-spec-'));
    try {
      // Deliberately empty — neither asyncapi.types.ts nor openapi.types.ts exists.
      const result = await checkGenerated(tempCommittedDir);
      expect(result.ok).toBe(false);
      const joined = result.messages.join('\n');
      expect(joined).toContain('is not committed');
    } finally {
      await rm(tempCommittedDir, { recursive: true, force: true });
    }
  });
});

/**
 * One true CLI-level test: proves the exact command `pnpm contracts:check`
 * runs (`tsx scripts/check.mts`) exits 0 against the real, unmodified
 * committed files — the end-to-end path, not just the imported function.
 * It never mutates `src/generated/`, so it cannot race the tests above or
 * `generate.spec.ts`'s own CLI test.
 */
describe('contracts:check — CLI, read-only', () => {
  // spawnSync tsx: allow cold start under parallel workspace test load
  it(
    'exits 0 and prints OK against the real committed files',
    () => {
      const result = spawnSync(tsxBin, ['scripts/check.mts'], {
        cwd: packageRoot,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('contracts:check OK');
    },
    30_000,
  );
});

describe('contracts:check — main(), in-process', () => {
  it('returns true, logs OK and leaves process.exitCode untouched on success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const originalExitCode = process.exitCode;
    try {
      const ok = await main(realCommittedDir);
      expect(ok).toBe(true);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('contracts:check OK'));
      expect(process.exitCode).toBe(originalExitCode);
    } finally {
      logSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it('returns false, logs to console.error and sets process.exitCode = 1 on drift', async () => {
    const tempCommittedDir = await mkdtemp(path.join(tmpdir(), 'otc-contracts-check-main-'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const originalExitCode = process.exitCode;
    try {
      // Empty directory — both generated files are "missing", a guaranteed drift.
      const ok = await main(tempCommittedDir);
      expect(ok).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('contracts:check FAILED'));
      expect(process.exitCode).toBe(1);
    } finally {
      errorSpy.mockRestore();
      process.exitCode = originalExitCode;
      await rm(tempCommittedDir, { recursive: true, force: true });
    }
  });
});
