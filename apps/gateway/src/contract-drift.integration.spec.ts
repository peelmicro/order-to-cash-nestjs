// Group E — the single most important test in this feature. Compares the
// RUNNING application's ACTUAL registered routes (introspected off the
// live Express router underneath the booted Nest app — never re-stated in
// TypeScript) against `specs/shared/openapi.yaml`'s eighteen OPERATIONS
// (17 `paths:` keys — `GET`+`POST /orders` share one path key — 18
// operations total; review finding F11 fixed a title/comment here that
// previously conflated the two), parsed with `js-yaml`. A route present in
// the app but absent from the spec, or vice versa, fails this test.
//
// Seventeen of the eighteen operations are Nest-decorated controller routes and
// are compared as SETS via `extractExpressRoutes` (introspection, both
// directions at once — extra AND missing both fail the same assertion).
// `GET /docs` is the one deliberate exception: it is served by raw
// `swagger-ui-express` middleware (`app.use('/docs', ...)`), not a Nest
// `@Get()` handler, so it never appears in the introspected controller-route
// set — it is proved separately, by an ACTUAL HTTP request confirming it
// answers 200 `text/html`.
//
// PROOF THIS TEST DETECTS DRIFT (not just re-stating the spec): this file's
// own `progress/impl_gateway_rest_auth.md` entry records the verbatim
// failure from two armed mutations — commenting out `OrdersController`'s
// `@Get(':id')` handler (a route present in the spec, missing from the
// app), and adding a stray extra `@Get('debug')` handler to `HealthController`
// (a route present in the app, absent from the spec) — both restored
// before this file was left in its final state.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import { startNatsTestFixture, type NatsTestFixture } from './test-support/nats-test-fixture';
import { bootGatewayTestApp, type GatewayTestApp } from './test-support/gateway-app-test-harness';
import { extractExpressRoutes, type RouteEntry } from './test-support/extract-express-routes';
import { extractOpenapiRoutes, loadOpenapiDocument } from './test-support/openapi-routes';

function routeKey(route: RouteEntry): string {
  return `${route.method} ${route.path}`;
}

describe('Gateway REST contract — no drift from openapi.yaml (Group E)', () => {
  let mongo: StandaloneMongoTestFixture;
  let nats: NatsTestFixture;
  let testApp: GatewayTestApp;

  beforeAll(async () => {
    mongo = await startAuthenticatedMongoTestFixture();
    nats = await startNatsTestFixture();
    testApp = await bootGatewayTestApp(mongo, nats);
  });

  afterAll(async () => {
    await testApp.close();
    await nats.teardown();
    await mongo.teardown();
  });

  it('every openapi.yaml path+method (except GET /docs) is registered as a Nest route, and every Nest route is in openapi.yaml', () => {
    const specRoutes = extractOpenapiRoutes(loadOpenapiDocument()).filter((route) => route.path !== '/docs');
    const appRoutes = extractExpressRoutes(testApp.app.getHttpAdapter().getInstance());

    const specKeys = new Set(specRoutes.map(routeKey));
    const appKeys = new Set(appRoutes.map(routeKey));

    const missingFromApp = [...specKeys].filter((key) => !appKeys.has(key));
    const extraInApp = [...appKeys].filter((key) => !specKeys.has(key));

    expect(missingFromApp, `spec routes the running app does NOT expose: ${missingFromApp.join(', ')}`).toEqual([]);
    expect(extraInApp, `app routes NOT documented in openapi.yaml: ${extraInApp.join(', ')}`).toEqual([]);

    // Sanity: the introspection actually found real routes, not an empty
    // router (which would make both arrays above vacuously equal).
    expect(appRoutes.length).toBeGreaterThan(10);
  });

  it('GET /docs answers 200 text/html — served by middleware, not a Nest route, proved separately', async () => {
    // swagger-ui-express redirects `/docs` -> `/docs/` (301) — one hop,
    // unauthenticated either side of it.
    const response = await request(testApp.app.getHttpServer()).get('/docs').redirects(1);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
  });

  it('openapi.yaml declares exactly 17 top-level paths and 18 operations — GET+POST /orders share one path key (review finding F11: this title previously said "20 operations")', () => {
    const document = loadOpenapiDocument() as { paths: Record<string, unknown> };
    expect(Object.keys(document.paths)).toHaveLength(17);
    expect(extractOpenapiRoutes(document)).toHaveLength(18);
  });

  it('F9 — GET /orders/stream is registered BEFORE GET /orders/:id, so the literal "stream" path segment is never swallowed by the :id wildcard', () => {
    // Regression guard for the review-found route-order bug: Nest/Express
    // match routes in REGISTRATION order, and `app.module.ts`'s own
    // `controllers` array comment records why `StreamController` must
    // precede `OrdersController` — this test names the invariant directly,
    // on the raw Express stack, rather than relying on `stream.integration.spec.ts`
    // failing incidentally (as it did, with a message — "expected 400 to be
    // 200" — that does not itself point at controller registration order).
    const expressApp = testApp.app.getHttpAdapter().getInstance() as {
      router?: { stack?: { route?: { path: string; methods: Record<string, boolean> } }[] };
      _router?: { stack?: { route?: { path: string; methods: Record<string, boolean> } }[] };
    };
    const stack = expressApp.router?.stack ?? expressApp._router?.stack ?? [];

    const streamIndex = stack.findIndex((layer) => layer.route?.path === '/orders/stream' && layer.route.methods.get);
    const orderIdIndex = stack.findIndex((layer) => layer.route?.path === '/orders/:id' && layer.route.methods.get);

    expect(streamIndex, 'GET /orders/stream must be a registered route').toBeGreaterThanOrEqual(0);
    expect(orderIdIndex, 'GET /orders/:id must be a registered route').toBeGreaterThanOrEqual(0);
    expect(streamIndex).toBeLessThan(orderIdIndex);
  });
});
