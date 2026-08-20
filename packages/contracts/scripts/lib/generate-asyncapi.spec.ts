import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { load as loadYaml } from 'js-yaml';
import { generateAsyncApiTypes } from './generate-asyncapi.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const specPath = path.join(repoRoot, 'specs', 'shared', 'asyncapi.yaml');

interface SchemaDoc {
  components?: { schemas?: Record<string, unknown> };
}

describe('generateAsyncApiTypes', () => {
  it('emits a DO-NOT-EDIT banner and no timestamp / absolute path', async () => {
    const output = await generateAsyncApiTypes(specPath);
    expect(output).toContain('DO NOT EDIT');
    expect(output).toContain('specs/shared/asyncapi.yaml');
    // Note: the source specs embed literal example timestamps
    // (e.g. '2026-08-18T10:15:00.000Z') inside doc comments — those are
    // static spec content, not generation artefacts, and are expected to
    // appear verbatim. What must never appear is this machine's absolute
    // repo path, which would make the file depend on where it was built.
    expect(output).not.toContain(repoRoot);
  });

  it('is byte-for-byte deterministic across two runs on the same input', async () => {
    const first = await generateAsyncApiTypes(specPath);
    const second = await generateAsyncApiTypes(specPath);
    expect(second).toBe(first);
  });

  it(
    'exports exactly one named type/interface per components.schemas key — ' +
      'the regression test for the root-interface-stripping regex, which once ' +
      'silently swallowed CatalogReferenceListReplyPayload because ' +
      'json-schema-to-typescript renders an empty interface body as `{}` on ' +
      'one line rather than `{\\n}\\n`',
    async () => {
      const raw = await readFile(specPath, 'utf8');
      const doc = loadYaml(raw) as SchemaDoc;
      const schemaKeys = Object.keys(doc.components?.schemas ?? {});
      expect(schemaKeys.length).toBeGreaterThan(0);

      const output = await generateAsyncApiTypes(specPath);
      const exportedNames = new Set(
        Array.from(output.matchAll(/^export (?:interface|type) ([A-Za-z0-9_]+)/gm)).map(
          (match) => match[1],
        ),
      );

      for (const key of schemaKeys) {
        expect(exportedNames.has(key), `expected an exported type named "${key}"`).toBe(true);
      }
      expect(exportedNames.size).toBe(schemaKeys.length);
    },
  );

  it('does not leak the synthetic AsyncApiComponents wrapper interface', async () => {
    // The wrapper's own declaration must be gone; json-schema-to-typescript's
    // "This interface was referenced by `AsyncApiComponents`'s JSON-Schema"
    // doc comments (harmless — they just name the synthetic root that made
    // `unreachableDefinitions: true` emit every schema) are expected to
    // remain and are not what this test guards against.
    const output = await generateAsyncApiTypes(specPath);
    expect(output).not.toMatch(/export interface AsyncApiComponents/);
    expect(output).not.toMatch(/export type AsyncApiComponents/);
  });

  it('rejects a spec with no components.schemas', async () => {
    const emptySpecPath = path.join(here, '__fixtures__', 'empty-schemas.yaml');
    await expect(generateAsyncApiTypes(emptySpecPath)).rejects.toThrow(
      /No components\.schemas found/,
    );
  });
});
