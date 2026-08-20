import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateAll } from './generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const defaultCommittedDir = path.join(packageRoot, 'src', 'generated');

const FILES = ['asyncapi.types.ts', 'openapi.types.ts'] as const;

export interface CheckResult {
  ok: boolean;
  messages: string[];
}

/**
 * Regenerates into a throwaway temp directory and diffs the result against
 * `committedDir`, file by file. Never writes to `committedDir` — this is a
 * read-only check, which is what lets it run safely against the package's
 * real `src/generated/` from a test without racing any other test that also
 * touches those files.
 */
export async function checkGenerated(committedDir: string): Promise<CheckResult> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'otc-contracts-check-'));
  const messages: string[] = [];
  try {
    await generateAll(tempDir);

    let ok = true;
    for (const file of FILES) {
      const committedPath = path.join(committedDir, file);
      const freshPath = path.join(tempDir, file);

      const [committed, fresh] = await Promise.all([
        readFile(committedPath, 'utf8').catch(() => null),
        readFile(freshPath, 'utf8'),
      ]);

      if (committed === null) {
        messages.push(
          `DRIFT: ${file} is not committed under ${committedDir} — run \`pnpm generate\`.`,
        );
        ok = false;
        continue;
      }

      if (committed !== fresh) {
        messages.push(
          `DRIFT: ${path.join(committedDir, file)} does not match a fresh \`pnpm contracts:generate\` run.`,
        );
        const result = spawnSync('diff', ['-u', committedPath, freshPath], { encoding: 'utf8' });
        if (result.stdout) {
          messages.push(result.stdout);
        } else if (result.error) {
          messages.push(
            `(diff unavailable; showing lengths only) committed: ${committed.length}, fresh: ${fresh.length}`,
          );
        }
        ok = false;
      }
    }

    if (ok) {
      messages.push(
        'contracts:check OK — committed generated files match a fresh `pnpm contracts:generate` run.',
      );
    } else {
      messages.push(
        'contracts:check FAILED — committed generated files are stale. Run `pnpm --filter @otc/contracts run generate` and commit the result.',
      );
    }

    return { ok, messages };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * The CLI entry point's own logic — `committedDir` defaults to the real
 * `src/generated/`, but is a parameter precisely so a test can exercise this
 * function's printing/exit-code behaviour in-process (where coverage
 * instrumentation can see it) against a throwaway directory, instead of only
 * through a spawned subprocess (which proves the real command works, but
 * whose coverage a spawned child process never reports back to the parent).
 */
export async function main(committedDir: string = defaultCommittedDir): Promise<boolean> {
  const { ok, messages } = await checkGenerated(committedDir);
  for (const message of messages) {
    (ok ? console.log : console.error)(message);
  }
  if (!ok) {
    process.exitCode = 1;
  }
  return ok;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error('contracts:check failed:', error);
    process.exitCode = 1;
  });
}
