// Group A — JWT auth end to end through real HTTP (CLAUDE.md: API tests
// black-box through the Gateway, Vitest + Supertest as the HTTP client
// only). Real NATS + real MongoDB (Testcontainers), the full `AppModule`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import { startNatsTestFixture, type NatsTestFixture } from './test-support/nats-test-fixture';
import { bootGatewayTestApp, TEST_OPERATOR_PASSWORD, TEST_OPERATOR_USERNAME, type GatewayTestApp } from './test-support/gateway-app-test-harness';
import { extractExpressRoutes } from './test-support/extract-express-routes';

describe('Gateway auth (Group A)', () => {
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

  it('POST /auth/login is unauthenticated and issues a bearer token for the configured operator', async () => {
    const response = await request(testApp.app.getHttpServer())
      .post('/auth/login')
      .send({ username: TEST_OPERATOR_USERNAME, password: TEST_OPERATOR_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.tokenType).toBe('Bearer');
    expect(typeof response.body.accessToken).toBe('string');
    expect(response.body.expiresIn).toBeGreaterThan(0);
  });

  it('POST /auth/login answers 401 problem+json on bad credentials', async () => {
    const response = await request(testApp.app.getHttpServer()).post('/auth/login').send({ username: 'operator', password: 'wrong' });

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('a protected route with no bearer token answers 401', async () => {
    const response = await request(testApp.app.getHttpServer()).get('/orders');
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('GET /auth/me describes the operator once authenticated', async () => {
    const login = await request(testApp.app.getHttpServer())
      .post('/auth/login')
      .send({ username: TEST_OPERATOR_USERNAME, password: TEST_OPERATOR_PASSWORD });
    const token = login.body.accessToken;

    const response = await request(testApp.app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.username).toBe('operator');
    expect(response.body.roles).toContain('operator');
  });

  it('F8 — exactly the four documented public routes reject nothing; every other registered route rejects an anonymous request with 401', async () => {
    const DUMMY_PARAM = '00000000-0000-4000-8000-000000000000';
    const PUBLIC_ROUTES = new Set(['POST /auth/login', 'GET /health/live', 'GET /health/ready']);
    // `GET /docs` is raw middleware, not a Nest route, so it never appears
    // in `extractExpressRoutes`'s introspection at all — it is proved
    // unauthenticated separately, by `contract-drift.integration.spec.ts`'s
    // own `GET /docs answers 200 text/html` case. Sanity below asserts it
    // stays absent from this set, so a future change that turns `/docs`
    // into a real Nest route does not silently escape this loop's coverage.

    const routes = extractExpressRoutes(testApp.app.getHttpAdapter().getInstance());
    expect(routes.length).toBeGreaterThan(10); // non-vacuity

    const protectedRoutes = routes.filter((route) => !PUBLIC_ROUTES.has(`${route.method} ${route.path}`));
    expect(protectedRoutes.length).toBeGreaterThan(0);
    expect(protectedRoutes.some((route) => route.path === '/docs')).toBe(false);

    for (const route of protectedRoutes) {
      const concretePath = route.path.replace(/\{[^}]+\}/g, DUMMY_PARAM);
      const agent = request(testApp.app.getHttpServer());
      const response =
        route.method === 'POST'
          ? await agent.post(concretePath).send({})
          : await agent.get(concretePath);

      expect(response.status, `${route.method} ${route.path} should reject an anonymous request with 401, got ${response.status}`).toBe(401);
    }

    // And the three public routes named above never reject for lacking a
    // token — proven by the OTHER cases in this file (login succeeds with
    // no header; `/health/live`/`/health/ready` answer 200 below).
  });

  it('GET /health/live and GET /health/ready are unauthenticated (openapi.yaml security: [])', async () => {
    const live = await request(testApp.app.getHttpServer()).get('/health/live');
    expect(live.status).toBe(200);
    expect(live.body.status).toBe('up');

    const ready = await request(testApp.app.getHttpServer()).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.readModel.status).toBe('up');
    expect(ready.body.checks.rpcTransport.status).toBe('up');
  });
});
