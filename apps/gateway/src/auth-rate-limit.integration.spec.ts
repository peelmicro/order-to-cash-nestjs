// Contract-implementation gap closure: openapi.yaml declares a `429
// TooManyRequests` response (`components.responses.TooManyRequests`,
// rendering `components.schemas.Problem` as `application/problem+json`) on
// `POST /auth/login`, but nothing implemented it. This file proves the real,
// spawned-in-process Gateway (real NATS + real MongoDB, Testcontainers,
// through `supertest` as an HTTP client only — CLAUDE.md Testing
// conventions) actually answers 429 with a genuine problem+json body once
// the configured limit on THAT ONE route is exceeded (this file's own
// requests all share one caller IP — `req.ip`, `ThrottlerGuard`'s own
// default tracker — so this proves the per-CALLER-IP budget, not a
// per-end-user one; see `.env.example`'s own comment on
// `GATEWAY_LOGIN_RATE_LIMIT`, review finding F2), and that no other route
// is throttled by the same guard.
//
// `GATEWAY_LOGIN_RATE_LIMIT`/`GATEWAY_LOGIN_RATE_WINDOW_MS` are set to a
// small, test-only limit BEFORE this file's own `bootGatewayTestApp` call —
// deliberately, so the 429 path can be proven in a handful of requests
// rather than the production default of 10/60s (see
// progress/impl_auth_rate_limit.md). This does NOT touch
// `gateway-app-test-harness.ts`'s shared `pointEnvAtFixtures`/`clearEnv`, so
// no other integration spec file (each of which boots its OWN fresh
// `AppModule`/throttler-storage instance) is affected.
//
// Round 3 (contract pass F5/R63, specs/shared/test-matrix.md §8.1): the
// `it` titles below are the literal three case names `test-matrix.md`
// cites for `api/login-rate-limit.spec`, kept verbatim so the matrix's
// file›case citation resolves, not merely paraphrased. All three tests
// SHARE one per-app throttler bucket (review finding F3): only the first
// case below needs a login to actually succeed (200), so it stays FIRST in
// file order, before either of the other two cases drives the bucket past
// its limit; the other two hammer with a BOUNDED loop until they OBSERVE a
// 429, rather than computing an exact request count, so neither depends on
// how many hits any earlier case in this file already spent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import { startNatsTestFixture, type NatsTestFixture } from './test-support/nats-test-fixture';
import { bootGatewayTestApp, TEST_OPERATOR_PASSWORD, TEST_OPERATOR_USERNAME, type GatewayTestApp } from './test-support/gateway-app-test-harness';

const TEST_LOGIN_RATE_LIMIT = 3;

describe('Gateway POST /auth/login rate limit — 429 application/problem+json (openapi.yaml TooManyRequests, R63)', () => {
  let mongo: StandaloneMongoTestFixture;
  let nats: NatsTestFixture;
  let testApp: GatewayTestApp;

  beforeAll(async () => {
    process.env.GATEWAY_LOGIN_RATE_LIMIT = String(TEST_LOGIN_RATE_LIMIT);
    process.env.GATEWAY_LOGIN_RATE_WINDOW_MS = '60000';
    mongo = await startAuthenticatedMongoTestFixture();
    nats = await startNatsTestFixture();
    testApp = await bootGatewayTestApp(mongo, nats);
  });

  afterAll(async () => {
    await testApp.close();
    await nats.teardown();
    await mongo.teardown();
    delete process.env.GATEWAY_LOGIN_RATE_LIMIT;
    delete process.env.GATEWAY_LOGIN_RATE_WINDOW_MS;
  });

  it("a client refused by the login limit continues to be served on every other endpoint — the limit is scoped to the login route, never global", async () => {
    const agent = request(testApp.app.getHttpServer());
    const login = await agent.post('/auth/login').send({ username: TEST_OPERATOR_USERNAME, password: TEST_OPERATOR_PASSWORD });
    expect(login.status).toBe(200);
    const token = login.body.accessToken as string;

    for (let i = 0; i < TEST_LOGIN_RATE_LIMIT + 2; i++) {
      const me = await agent.get('/auth/me').set('Authorization', `Bearer ${token}`);
      expect(me.status).toBe(200);
    }
  });

  // Review finding F3 (progress/review_auth_rate_limit.md) — this used to
  // compute an exact request count that was only correct because the
  // PRECEDING test happened to consume exactly one hit of the same
  // per-app throttler bucket first. A bounded loop that hammers until it
  // OBSERVES a 429 (rather than counting up to a precomputed number)
  // removes that ordering dependency: this test now passes regardless of
  // how many hits any earlier test in this file already spent, as long as
  // the bound below is generous enough to reach the limit from zero.
  it('exceeding the login rate limit answers 429 with an `application/problem+json` body matching `components.schemas.Problem` and a `Retry-After` header carrying a whole number of seconds, and issues no token', async () => {
    const agent = request(testApp.app.getHttpServer());
    const MAX_ATTEMPTS = TEST_LOGIN_RATE_LIMIT + 5;
    let limited: request.Response | undefined;

    for (let i = 0; i < MAX_ATTEMPTS && !limited; i++) {
      const attempt = await agent.post('/auth/login').send({ username: TEST_OPERATOR_USERNAME, password: 'wrong-password' });
      if (attempt.status === 429) {
        limited = attempt;
      } else {
        expect(attempt.status).toBe(401);
      }
    }

    expect(limited, `expected a 429 within ${MAX_ATTEMPTS} attempts (limit is ${TEST_LOGIN_RATE_LIMIT}) but every attempt answered 401`).toBeDefined();
    // The full `components.schemas.Problem` shape (openapi.yaml) — every
    // field, not merely `status`/`code`/`correlationId` (review finding
    // F4): a future edit that blanked `title`/`detail`/`type` would leave
    // this suite green without these three positive assertions.
    expect(limited!.status).toBe(429);
    expect(limited!.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(limited!.body.type).toBe('about:blank');
    expect(limited!.body.title).toBe('Too many requests');
    expect(limited!.body.status).toBe(429);
    expect(limited!.body.detail).toBe('Too many login attempts — try again later.');
    expect(limited!.body.code).toBe('TOO_MANY_REQUESTS');
    expect(typeof limited!.body.correlationId).toBe('string');
    expect(limited!.body.correlationId.length).toBeGreaterThan(0);
    expect(typeof limited!.body.occurredAt).toBe('string');

    // R63(b) / specs/shared/openapi.yaml `TooManyRequests.headers.Retry-After`
    // (`required: true`, `type: integer`, `minimum: 0`) — the very clause
    // this contract pass exists to document. Asserted as a WHOLE NUMBER
    // parsed from the header, not merely "present": the contract
    // deliberately excludes RFC 9110's HTTP-date alternative for this
    // header, and a plain `toBeDefined()` would not catch an
    // implementation that emitted a date instead of delta-seconds — the
    // `/^\d+$/` shape check fails loudly on a date string, which contains
    // letters and commas that pure digits never do.
    const retryAfterHeader = limited!.headers['retry-after'];
    expect(retryAfterHeader).toBeDefined();
    expect(retryAfterHeader).toMatch(/^\d+$/);
    const retryAfterSeconds = Number(retryAfterHeader);
    expect(Number.isInteger(retryAfterSeconds)).toBe(true);
    expect(retryAfterSeconds).toBeGreaterThanOrEqual(0);

    // "…issues no token" — the 429 response must not carry an accessToken.
    expect(limited!.body.accessToken).toBeUndefined();
  });

  // R63(c) — the refusal must be independent of whether the submitted
  // credentials were valid: a 429 that only fires for bad passwords would
  // leak whether an account exists. Bounded loop per the file-header note
  // above — this case does not assume the bucket is still fresh when it
  // starts, only that hammering will observe a 429 within a generous bound.
  it('the same 429 is returned for valid and for invalid credentials once the limit is exceeded, so the refusal reveals nothing about the credentials', async () => {
    const agent = request(testApp.app.getHttpServer());
    const MAX_ATTEMPTS = TEST_LOGIN_RATE_LIMIT + 5;
    let tripped = false;

    for (let i = 0; i < MAX_ATTEMPTS && !tripped; i++) {
      const attempt = await agent.post('/auth/login').send({ username: TEST_OPERATOR_USERNAME, password: 'wrong-password' });
      if (attempt.status === 429) {
        tripped = true;
      } else {
        expect(attempt.status).toBe(401);
      }
    }
    expect(tripped, `expected the limit to trip within ${MAX_ATTEMPTS} attempts (limit is ${TEST_LOGIN_RATE_LIMIT})`).toBe(true);

    // Once tripped, a request carrying the CORRECT operator credentials
    // must ALSO be refused with 429 and issue no token — proving the
    // refusal does not depend on credential validity.
    const validAttempt = await agent.post('/auth/login').send({ username: TEST_OPERATOR_USERNAME, password: TEST_OPERATOR_PASSWORD });
    expect(validAttempt.status).toBe(429);
    expect(validAttempt.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(validAttempt.body.code).toBe('TOO_MANY_REQUESTS');
    expect(validAttempt.body.accessToken).toBeUndefined();
  });
});
