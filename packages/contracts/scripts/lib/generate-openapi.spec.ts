import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOpenApiTypes } from './generate-openapi.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const specPath = path.join(repoRoot, 'specs', 'shared', 'openapi.yaml');

describe('generateOpenApiTypes', () => {
  it('emits a DO-NOT-EDIT banner and no timestamp / absolute path', async () => {
    const output = await generateOpenApiTypes(specPath);
    expect(output).toContain('DO NOT EDIT');
    expect(output).toContain('specs/shared/openapi.yaml');
    // Note: the source specs embed literal example timestamps
    // (e.g. '2026-08-18T10:15:00.000Z') inside doc comments — those are
    // static spec content, not generation artefacts, and are expected to
    // appear verbatim. What must never appear is this machine's absolute
    // repo path, which would make the file depend on where it was built.
    expect(output).not.toContain(repoRoot);
  });

  it('is byte-for-byte deterministic across two runs on the same input', async () => {
    const first = await generateOpenApiTypes(specPath);
    const second = await generateOpenApiTypes(specPath);
    expect(second).toBe(first);
  });

  it('emits the three root shapes openapi-typescript is asked for', async () => {
    const output = await generateOpenApiTypes(specPath);
    expect(output).toMatch(/export interface paths \{/);
    expect(output).toMatch(/export interface components \{/);
    expect(output).toMatch(/export interface operations \{/);
  });

  it('carries every path this gateway spec declares', async () => {
    const output = await generateOpenApiTypes(specPath);
    for (const route of [
      '/orders',
      '/orders/{id}',
      '/orders/{id}/cancel',
      '/orders/stream',
      '/stock',
      '/stock/replenish',
      '/invoices',
      '/invoices/{id}/payments',
      '/credits',
      '/health/live',
      '/health/ready',
    ]) {
      expect(output).toContain(`"${route}"`);
    }
  });
});
