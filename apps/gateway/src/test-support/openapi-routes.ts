// Parses `specs/shared/openapi.yaml` (js-yaml — never a hand-copied route
// list) and returns every {method, path} pair it declares. The single
// source of truth for the Group E contract-drift test.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { RouteEntry } from './extract-express-routes';

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace'];

export const OPENAPI_SPEC_PATH = path.resolve(__dirname, '../../../../specs/shared/openapi.yaml');

export function loadOpenapiDocument(): Record<string, unknown> {
  return yaml.load(readFileSync(OPENAPI_SPEC_PATH, 'utf8')) as Record<string, unknown>;
}

export function extractOpenapiRoutes(document: Record<string, unknown>): RouteEntry[] {
  const paths = document.paths as Record<string, Record<string, unknown>>;
  const routes: RouteEntry[] = [];
  for (const [routePath, operations] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      if (operations[method]) {
        routes.push({ method: method.toUpperCase(), path: routePath });
      }
    }
  }
  return routes;
}
