// Walks the REAL, live Express router of a booted Nest application and
// returns every registered {method, path} pair, converting Express's
// `:param` path-parameter syntax to openapi.yaml's `{param}` syntax so the
// two can be compared directly. This is the "running application's actual
// routes" half of Group E's contract-drift test — never a re-statement of
// the spec in TypeScript.
export interface RouteEntry {
  readonly method: string;
  readonly path: string;
}

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: ExpressLayer[] };
  regexp?: RegExp;
}

function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** `app.getHttpAdapter().getInstance()` — the raw Express app. */
export function extractExpressRoutes(expressApp: unknown): RouteEntry[] {
  const router = (expressApp as { router?: { stack?: ExpressLayer[] }; _router?: { stack?: ExpressLayer[] } }).router
    ?? (expressApp as { _router?: { stack?: ExpressLayer[] } })._router;
  const stack = router?.stack ?? [];

  const routes: RouteEntry[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter((method) => layer.route!.methods[method]);
      for (const method of methods) {
        routes.push({ method: method.toUpperCase(), path: toOpenApiPath(layer.route.path) });
      }
    }
  }
  return routes;
}
