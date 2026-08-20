import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateAsyncApiTypes } from './lib/generate-asyncapi.mjs';
import { generateOpenApiTypes } from './lib/generate-openapi.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

const asyncApiSpecPath = path.join(repoRoot, 'specs', 'shared', 'asyncapi.yaml');
const openApiSpecPath = path.join(repoRoot, 'specs', 'shared', 'openapi.yaml');

const generatedDir = path.join(packageRoot, 'src', 'generated');

export async function generateAll(outputDir: string): Promise<void> {
  const [asyncApiTypes, openApiTypes] = await Promise.all([
    generateAsyncApiTypes(asyncApiSpecPath),
    generateOpenApiTypes(openApiSpecPath),
  ]);

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'asyncapi.types.ts'), asyncApiTypes, 'utf8');
  await writeFile(path.join(outputDir, 'openapi.types.ts'), openApiTypes, 'utf8');
}

/**
 * The CLI entry point's own logic — `outputDir` defaults to the real
 * `src/generated/`, but is a parameter precisely so a test can exercise this
 * function's printing/error-handling behaviour in-process (where coverage
 * instrumentation can see it) against a throwaway directory, instead of only
 * through a spawned subprocess (which proves the real command works, but
 * whose coverage a spawned child process never reports back to the parent).
 */
export async function main(outputDir: string = generatedDir): Promise<void> {
  await generateAll(outputDir);
  console.log(
    `contracts:generate — wrote ${path.relative(repoRoot, outputDir)}/{asyncapi,openapi}.types.ts`,
  );
}

// Only run as a side effect when this file is executed directly (`tsx
// scripts/generate.mts` / `pnpm generate`). `generateAll` is also imported by
// `scripts/check.mts` and by `scripts/generate.spec.ts`, neither of which
// wants importing this module to overwrite the committed generated files as
// a side effect.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error('contracts:generate failed:', error);
    process.exitCode = 1;
  });
}
