import { readFile } from 'node:fs/promises';
import { load as loadYaml } from 'js-yaml';
import openapiTS, { astToString } from 'openapi-typescript';
import { bannerFor } from './banner.mjs';

/**
 * Generator choice for the REST contract: `openapi-typescript`. It is the
 * natural fit the task calls for — types-only (no runtime shipped to
 * consumers), a native OpenAPI 3.1 parser (this spec uses 3.1's
 * `type: ['string', 'null']`-free `oneOf [.., {type: 'null'}]` style, RFC
 * 9457 `application/problem+json` responses and `const` throughout, all of
 * which it handles natively), and it emits one deterministic `paths` /
 * `components` / `operations` module with no post-processing needed.
 */

/**
 * Reads `specs/shared/openapi.yaml` and compiles it to a single
 * deterministic TypeScript module (`paths`, `components`, `operations`,
 * `webhooks`). `openapi-typescript` is given the already-parsed document
 * object (not a file path) so generation never depends on the process's
 * working directory.
 */
export async function generateOpenApiTypes(specPath: string): Promise<string> {
  const raw = await readFile(specPath, 'utf8');
  const doc = loadYaml(raw);

  const ast = await openapiTS(doc as never, {
    additionalProperties: false,
    alphabetize: true,
    excludeDeprecated: false,
    exportType: false,
    immutable: false,
  });

  const body = astToString(ast);

  return bannerFor('specs/shared/openapi.yaml') + body.trimEnd() + '\n';
}
