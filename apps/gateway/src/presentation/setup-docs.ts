// `GET /docs` (openapi.yaml `apiDocs`) — shared by `main.ts` and every test
// harness that boots a real `INestApplication` directly (bypassing
// `main.ts`'s own `bootstrap()`), so the two paths can never drift apart on
// whether `/docs` is actually mounted. Raw Express middleware
// (`app.use(...)`), not a Nest `@Get()` handler — see
// `contract-drift.integration.spec.ts`'s own header for why.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import yaml from 'js-yaml';
import swaggerUi from 'swagger-ui-express';

const OPENAPI_SPEC_PATH = path.resolve(__dirname, '../../../../specs/shared/openapi.yaml');

export function setupDocs(app: INestApplication): void {
  const openapiDocument = yaml.load(readFileSync(OPENAPI_SPEC_PATH, 'utf8')) as Record<string, unknown>;
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));
}
