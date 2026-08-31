# Review — `auth_rate_limit` (POST /auth/login 429 contract-gap closure)

**Verdict: REJECTED** — one blocking defect (F1). Everything the brief named as "most worth attacking" was probed first-hand and, apart from F1, held up: the contract conformance is real, the `classify()` ordering is real and load-bearing, the scope containment is genuinely route-scoped, both armed deletions reproduce, the test-only limit override cannot leak, and the production default is unweakened. The rejection rests on F1 alone, and F1 is small.

---

## What I probed myself, and what I deliberately did not

**Probed first-hand (my own runs, not the implementer's):**

- A throwaway reviewer probe booting the **real `AppModule`** against **real Testcontainers MongoDB + NATS** (the repo's own `bootGatewayTestApp`), driving real HTTP through supertest, dumping the verbatim status line, **all** response headers and the raw response text of an actually-throttled `POST /auth/login`.
- A second, container-free probe booting a minimal Nest app around the **real `ThrottlerGuard`** and the **real `ProblemJsonExceptionFilter`**, to exercise config edges (`""`, `"abc"`, `"0"`, `" "`, `"-5"`) that no existing test reaches.
- Scope containment by hammering four *other* routes past the configured limit against the real app.
- Both armed deletions, re-armed by me and restored byte-for-byte (md5 verified).
- A two-file `process.env` isolation experiment under the actual `vitest.integration.config.mts`, to settle the leak question empirically rather than by reasoning about vitest defaults.
- `npx eslint` on the six changed/added gateway files.
- Repo-wide census of `POST /auth/login` call sites per file (to check the "Trap 2" claim independently), plus the n8n workflows and the Playwright suite.

**Deliberately not done:** I did **not** re-run `pnpm quality`, the gateway unit suite or the gateway integration suite in full — the leader is running `pnpm quality` in parallel, and re-running a suite the implementer just ran is duplicated cost with no independent information. I ran only the specific files whose claims were under test (`problem-json.filter.spec.ts`, `login-throttle.config.spec.ts`, `auth-rate-limit.integration.spec.ts`) plus my own probes. I also did not attempt an OpenAPI schema-validator run against the live response; I checked the `Problem` schema's fields by hand against the captured body instead.

**Working tree restored.** Both mutations reverted and confirmed byte-identical by md5 against a pre-review baseline; all probe files deleted; `git status --porcelain` at the end lists exactly the same twelve entries it listed at the start. I ran no `git commit` and no `git push`.

---

## Evidence: the actual throttled response

Captured from the real Gateway (real `AppModule`, real containers), 6th `POST /auth/login` inside the window with `GATEWAY_LOGIN_RATE_LIMIT=6`:

```
statuses: [401,401,401,401,401,429]
content-type: application/problem+json; charset=utf-8
headers: {"x-powered-by":"Express","x-correlation-id":"9c35d855-df41-4ca3-aa12-810b8cb1e9de","retry-after":"60","content-type":"application/problem+json; charset=utf-8","content-length":"241",...}
raw body: {"type":"about:blank","title":"Too many requests","status":429,"detail":"Too many login attempts — try again later.","code":"TOO_MANY_REQUESTS","correlationId":"9c35d855-df41-4ca3-aa12-810b8cb1e9de","occurredAt":"2026-08-30T17:55:42.976Z"}
```

Checked against `specs/shared/openapi.yaml` `components.schemas.Problem` (`required: [title, status, code]`, plus the optional `type` / `detail` / `correlationId` / `occurredAt`):

| Field | Required | Present | Value sane |
|---|---|---|---|
| `type` | no | yes | `about:blank` — matches the schema `default` |
| `title` | **yes** | yes | `Too many requests` — human-readable, no class name |
| `status` | **yes** | yes | `429`, inside `100..599`, agrees with the HTTP status line |
| `detail` | no | yes | human wording, no library internals |
| `code` | **yes** | yes | `TOO_MANY_REQUESTS` — stable, machine-readable |
| `correlationId` | no | yes | a real UUID, **and identical to the `x-correlation-id` response header** (so R58's "same id on the line and in the body" holds on this path too) |
| `occurredAt` | no | yes | ISO-8601 UTC |

Media type is `application/problem+json; charset=utf-8` — **not** `application/json`. The claim in the impl record is true. The response additionally carries `Retry-After: 60`, which the contract does not declare (see F5).

---

## Findings

### F1 — BLOCKING. `loadLoginThrottleConfig` silently turns the rate limit into a no-op on a malformed value, and bricks login entirely on a zero one. No validation, no clamping, no log, no test.

`apps/gateway/src/infrastructure/auth/login-throttle.config.ts:20-21` is a bare `Number(env.X ?? default)` with no guard:

```ts
limit: Number(env.GATEWAY_LOGIN_RATE_LIMIT ?? 10),
ttlMs: Number(env.GATEWAY_LOGIN_RATE_WINDOW_MS ?? 60000),
```

`??` only defends against *absent*; it does nothing for *present and malformed*. Measured first-hand against the real `ThrottlerGuard` over real HTTP:

| `GATEWAY_LOGIN_RATE_LIMIT` | loaded config | observed behaviour |
|---|---|---|
| absent | `{limit:10, ttlMs:60000}` | correct |
| `"abc"` (or `"10 # attempts"`, `"1_000"`, `"10,"`) | `{limit:NaN, ttlMs:NaN}` | **25 of 25 requests returned 200 — the guard never throttles at all.** Node also prints `TimeoutNaNWarning: NaN is not a number. Timeout duration was set to 1.` |
| `"0"` (window valid) | `{limit:0, ttlMs:60000}` | **the very first request returns 429.** Login is completely unreachable |
| `" "` (a stray space) | `{limit:0, ttlMs:60000}` | same as `"0"` — total login outage |
| `"-5"` | `{limit:-5, ttlMs:60000}` | first request 429 — total login outage |
| `""` | `{limit:0, ttlMs:0}` | not throttled (the zero TTL masks the zero limit) — a third, different wrong answer |

Both of the failure modes the brief named are present, and they are *opposite*, so neither is detectable by "it looks configured". The NaN case is the serious one: a security control that reports nothing and enforces nothing. `GATEWAY_LOGIN_RATE_LIMIT` reaches the container through `env_file: [.env]` (`docker-compose.apps.yml:313`), so a hand-edited `.env` with a trailing comment or a thousands separator is a realistic operator action, and its entire consequence is that the 429 the contract promises silently stops existing — while `openapi.yaml` continues to promise it.

`apps/gateway/src/infrastructure/auth/login-throttle.config.spec.ts` tests only the two happy paths (defaults, and `'3'`/`'5000'`). Nothing in the repo covers any of the six rows above.

I acknowledge that `sse.config.ts` and `issued-order-window.config.ts` use the same unvalidated `Number(...)` shape, and that consistency was clearly the intent. That argument does not carry here: a wrong SSE buffer capacity degrades a stream, whereas a wrong value in *this* loader either removes the only brute-force defence on the only unauthenticated write route or makes the API's only login route permanently unreachable. This is precisely the "correct code, silently wrong at runtime, no guard" class this project has already been bitten by twice (features 17 and 19).

**What must change:** validate in the loader — require a finite integer `>= 1` for `limit` and `>= 1` for `ttlMs`, and on anything else either fail fast at boot or fall back to the documented default *and log it*, but never silently accept `NaN`/`0`/negative. Add named tests for at least `"abc"`, `"0"`, `""` and `"-5"` asserting the chosen behaviour. If the fallback route is taken, the test must assert the log line too, otherwise the fallback is itself silent.

### F2 — Non-blocking, but the documentation is currently false. "Tracked per client IP" is not what happens for browser users.

`.env.example:363` and `progress/impl_auth_rate_limit.md:50` both state the limit is tracked per client IP. `ThrottlerGuard`'s default tracker is `req.ip`, and the Gateway does not enable Express `trust proxy`. But the web UI does **not** talk to the Gateway from the browser: `apps/web/server/api/auth/login.post.ts:13` calls `gatewayFetchPublic(event, '/auth/login', …)` server-side, so **every** browser login arrives at the Gateway from the single `otc-web` container's IP. In the containerised stack the policy is therefore not 10/min per user, it is **10/min shared by every web user at once**, and one operator's typos throttle everybody else. The BFF forwards no `X-Forwarded-For`, and the Gateway would ignore it if it did.

The same collapse applies to n8n: all four workflows log in from the one `otc-n8n` container IP. At the shipped intervals (45s / 120s / 300s) that is ~2 logins/min and fine — but `ORDER_GENERATOR_INTERVAL_SECONDS` is a documented, supported knob, and the *previous* review of `n8n_workflows` itself ran it at 7s. At 7s the generator alone is ~8.6 logins/min; at 6s the combined n8n bucket exceeds 10/min and the generator's login starts receiving a 429 it has no handler for (it has a `401` re-login path, not a `429` one). Nothing breaks today; the interaction is simply undocumented.

Not blocking, because the code does what it was designed to do and fixing it properly (trust-proxy plus XFF forwarding from the BFF, or a different tracker) is arguably a separate decision. But the two sentences that assert per-client-IP tracking are wrong as written and should be corrected in the same pass — that is a five-minute edit, and leaving a false statement in `.env.example` is worse than the behaviour it describes.

### F3 — Non-blocking. The integration spec's two `it` blocks are order-coupled.

`apps/gateway/src/auth-rate-limit.integration.spec.ts:63-70` — the second test's arithmetic (`TEST_LOGIN_RATE_LIMIT - 1` more attempts) is only correct because the *first* test happened to consume exactly one hit of the same per-app bucket, and the comment says so. Reorder, skip or `.only` the first test and the second computes the wrong number of requests. It fails loudly rather than silently, so this is a maintenance hazard, not a correctness hole; still, a self-contained loop that hammers until it sees a 429 (bounded) would remove the coupling entirely. My own probe did exactly that and reached the 429 deterministically.

### F4 — Non-blocking. The integration test under-asserts the contract it names.

The test is titled "…matching components.schemas.Problem…" but asserts only `status`, `content-type`, `code`, `status`, `correlationId` and `typeof occurredAt`. It never asserts `title`, `detail` or `type`. The real response does carry all three correctly (evidence above), and the unit filter spec asserts `title`/`detail` *negatively* (`not.toBe('ThrottlerException')`), but **no test anywhere positively asserts `title === 'Too many requests'`** — so a future edit that blanked the title would leave the whole suite green while the response stopped matching the required field. Cheap to close: two more `expect`s in the file that already claims to check the shape. The impl record's statement that the test asserts "the full `components.schemas.Problem` shape" (line 155-156) overstates what is in the file.

### F5 — Informational. `Retry-After` is emitted but not documented in the contract this pass exists to make true.

The real response carries `retry-after: 60` (the library adds it). `specs/shared/openapi.yaml:1000-1005` `components.responses.TooManyRequests` declares only a description and the problem+json body — no `headers:`. Not a violation, and not something I would reject over. Worth adding while the file is being thought about, precisely because `specs/shared/` is inherited verbatim by assessments #8 and #9, and a documented `Retry-After` is a header they would otherwise each have to rediscover.

### F6 — Informational. `afterAll` cleanup ordering is fragile, but the fragility is unreachable.

`auth-rate-limit.integration.spec.ts:41-46` deletes the two env vars *after* three awaited teardowns; if any of them throws, the deletes never run. I checked whether that could matter and it cannot: under `vitest.integration.config.mts` each spec file runs in its own forked process, so `process.env` does not cross files at all. Proved rather than assumed — a two-file experiment where file A sets `REVIEW_ISO_PROBE` and never cleans up reports `REVIEW_ISO_PROBE in file B = undefined` in the later file. Recorded because the implementer's reasoning for the same conclusion rested on the `afterAll` cleanup, which is the weaker of the two arguments.

---

## Claims verified as true

**1. Contract conformance — TRUE.** Media type, every required `Problem` field, and sensible values; see the evidence table above. The `correlationId` in the body matches the `x-correlation-id` header on the same response.

**2. `classify()` ordering — TRUE and load-bearing.** `apps/gateway/src/presentation/problem-json.filter.ts:98-105` places the `ThrottlerException` branch at line 98, ahead of the generic `instanceof HttpException` at line 138. I armed it away (`if (false && exception instanceof ThrottlerException)`) and re-ran `problem-json.filter.spec.ts`:

```
AssertionError: expected 'ThrottlerException' not to be 'ThrottlerException' // Object.is equality
 ❯ src/presentation/problem-json.filter.spec.ts:83:28
```

with the accompanying log line proving the leak the implementer described was exactly real — `{"code":"TOO_MANY_REQUESTS","status":429,"message":"ThrottlerException: Too Many Requests"}`. So `status` and `code` would indeed have looked fine while `title` and `detail` leaked the class name and the library's internal wording. Restored; md5 matches the pre-mutation baseline.

**3. Scope containment — TRUE, and proved independently of the implementer's own test.** No `APP_GUARD` for the throttler exists (`app.module.ts:206-209` registers only `JwtAuthGuard`, `ProblemJsonExceptionFilter`, `RequestLatencyInterceptor`); the guard is method-level at `auth.controller.ts:28`. Against the real app with `GATEWAY_LOGIN_RATE_LIMIT=6` I hammered four other routes well past the limit:

```
/health/live      (18 requests): all 200
/auth/me          (18 requests): all 200
/catalog/products  (8 requests): all 503   (RPC no-responder — never 429)
/orders/{ref}      (8 requests): all 400   (validation — never 429)
```

and then, *after* driving `POST /auth/login` to a 429, confirmed `/auth/me` and `/health/live` still answered 200 — the throttled state does not spill. The `@Global()` `ThrottlerModule` therefore exports providers without applying anything, which is the intended arrangement.

**4. Both armed deletions — BOTH REPRODUCE.** Probe 2 above. Probe 1: I commented out `@UseGuards(ThrottlerGuard)` and re-ran `auth-rate-limit.integration.spec.ts` against real containers:

```
FAIL  src/auth-rate-limit.integration.spec.ts > … > answers 429 application/problem+json, matching components.schemas.Problem, on the (4)th POST /auth/login within the window
AssertionError: expected 401 to be 429 // Object.is equality
 ❯ src/auth-rate-limit.integration.spec.ts:74:28
```

— the same test name, the same line, the same message the impl record quotes. Restored; md5 matches. Note that the file's *other* test ("GET /auth/me is never throttled…") passes identically with the guard removed; that is correct for a negative test — it guards against a future `APP_GUARD`, not against the guard's absence — but it means the 429 assertion is carrying the whole weight of Probe 1, which it does.

**5. Test-only override cannot leak; production default unweakened — TRUE.** The `GATEWAY_LOGIN_RATE_LIMIT=3` is set inside `auth-rate-limit.integration.spec.ts`'s own `beforeAll` and deleted in `afterAll`; it does not go near `gateway-app-test-harness.ts`'s `pointEnvAtFixtures`/`clearEnv`. Stronger than that: per-file process isolation makes a leak impossible even if the cleanup never ran (F6). A repo-wide grep confirms only that one spec, the loader, and `.env.example` mention the variable at all. `.env.example:367,371` carry `10` / `60000`, and `login-throttle.config.ts:20-21` defaults to `10` / `60000` — the production policy was genuinely not lowered for the tests.

**6. "Trap 2" (existing suites that log in) — TRUE.** Counted per file myself: `auth.integration.spec.ts` has exactly 3 real `POST /auth/login` calls (lines 30, 40, 55), `stream.integration.spec.ts` 2, every other gateway integration file 1, `black-box-api.integration.spec.ts` logs in once in `beforeAll` and reuses the token, and `apps/web/e2e/global.setup.ts` logs in once for the whole Playwright run. Maximum 3 per file against an unweakened limit of 10. No suite is at risk.

**7. Conventions — CLEAN.**

- No new Nest-decorated class with constructor parameters was introduced, so the explicit-`@Inject(TOKEN)` rule has nothing new to police; `ThrottlerModule.forRootAsync({ useFactory })` takes no injected arguments, so an `inject: []` would be noise.
- Vitest only; no Jest anywhere in the change.
- No `@nestjs/*` import anywhere under any `domain/` folder — the only hit in `apps/gateway/src/domain/` is a comment in `order-read-model-mapper.ts` describing the rule.
- No `@MessagePattern`/`@EventPattern` added, so the transport rule is not engaged.
- `npx eslint` on all six changed/added gateway files exits 0 — run by me, not taken from the report.

---

## Scope

**No scope violation by the implementer.** Files changed: `.env.example`, `apps/gateway/package.json`, `apps/gateway/src/{app.module.ts, presentation/auth.controller.ts, presentation/problem-json.filter.ts, presentation/problem-json.filter.spec.ts}`, the three new files under `apps/gateway/src/`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` (an unavoidable consequence of the permitted `package.json` + catalog edit). `specs/shared/openapi.yaml` is untouched, which is the right call — I read `/auth/login`'s responses and `components.responses.TooManyRequests` and the `429` declaration is correct as written; the gap was purely on the implementation side. `README.md` is the leader's concurrent edit and is excluded from this assessment as instructed.

**Requirement traceability:** none applies. `grep -in "429|throttl|rate.limit|TooManyRequests" specs/shared/test-matrix.md` and the same grep over `specs/shared/requirements.md` both return nothing, and `feature_list.json` contains no `auth_rate_limit`/`throttle` entry. This is an unnumbered contract-gap closure, not a spec'd feature, so there is no `R<n>` → test row to flip and no `feature_list.json` status to move back to `in_progress` — there is no entry to move. If the leader wants this tracked as a feature, it needs an entry created first.

---

## CHECKPOINTS.md — boxes walked for this change

Only boxes this change can affect are marked; the rest are outside its blast radius and were not re-walked.

**C3 — Architecture**
- [x] No `@nestjs/*` / `drizzle-orm` / `kafkajs` / `nats` / `mongodb` import inside any `domain/` folder — grepped `apps/gateway/src/domain/`, the only match is a comment naming the rule.
- [x] No cross-service database access — no persistence touched.
- [x] No shared runtime code beyond `shared-kernel` and `contracts` — `@nestjs/throttler` is a gateway-local dependency, catalogued but declared only in `apps/gateway/package.json`.
- [x] Every inter-service interaction classifiable as Kafka-fact or NATS-RPC — none added.
- [x] No stray debug logging, no context-free TODOs — none in the diff.

**C4 — Verification**
- [ ] `pnpm quality` passes — **not verified by me by design**; the leader is running it in parallel. My scoped runs (`problem-json.filter.spec.ts` 13 tests, `login-throttle.config.spec.ts` 2 tests, `auth-rate-limit.integration.spec.ts` 2 tests) are green, and eslint on the changed files exits 0.
- [x] Domain tests pure — no domain test added or changed.
- [x] Integration tests use Testcontainers against real NATS / MongoDB, not mocks — confirmed by running the new spec myself and watching the containers come up.
- [ ] Coverage thresholds — not independently re-measured (the leader's `pnpm quality` gate covers it). Noting only that this change adds no `domain/` code, so the ≥80% domain gate is untouched.
- [x] No Jest anywhere — Vitest only in the change.

**C5 — Session close**
- [x] No suspicious untracked files — the three new files are legitimate source/spec; my own probe files are deleted and the tree matches its pre-review state.
- [ ] `progress/history.md` entry with an effort record — **not written, and correctly so**: the verdict is REJECTED, and the change is not a `feature_list.json` feature. For the leader's benefit, the observed bracket from file mtimes is implementation **≈19:36:47 → 19:49:36, ≈13 min, 1 session** (`pnpm-workspace.yaml` first, `progress/impl_auth_rate_limit.md` last), and this review **≈19:52 → 20:05, ≈13 min, 1 session**. Caution for anyone recomputing: `auth.controller.ts` (19:57:39) and `problem-json.filter.ts` (19:52:34) now carry *my* mutation-and-restore mtimes, not authoring times; their content is md5-identical to what the implementer left.
- [x] `feature_list.json` reflects true state — unchanged, because this change has no entry in it.
- [ ] Human told what was done and how to test manually — the leader's job, after the fix.
- [x] Claude did not commit — I ran no `git commit` and no `git push`.

**C6 — SDD:** not applicable; this is not an `sdd: true` feature and has no `specs/<name>/`.

**C7 — Trilogy reusability**
- [x] `specs/shared/` contains no stack specifics — untouched by this change, and the fix correctly went into the implementation rather than into the shared contract. (F5 suggests one optional, stack-agnostic addition there.)
- [x] `n8n/workflows/*.json` still reference only the Gateway REST API — untouched. See F2 for an interval-tuning interaction worth documenting.

---

## What must change before re-review

1. **F1 (blocking).** Validate `GATEWAY_LOGIN_RATE_LIMIT` and `GATEWAY_LOGIN_RATE_WINDOW_MS` in `loadLoginThrottleConfig`: finite integers, `limit >= 1`, `ttlMs >= 1`. Anything else must either fail fast at boot or fall back to the documented default **with a log line** — never silently yield `NaN` (limit off) or `0`/negative (login bricked). Add named tests for `"abc"`, `"0"`, `""` and `"-5"`, and arm one of them away to confirm it fails.
2. **F2 (recommended in the same pass, cheap).** Correct the "tracked per client IP" wording in `.env.example` and in `progress/impl_auth_rate_limit.md` to state what actually happens behind the Nuxt BFF, and note the n8n interval interaction. Whether to add `trust proxy` + XFF forwarding is a separate decision — say which was chosen and why.
3. **F4 (recommended).** Add positive `title` / `detail` / `type` assertions to the integration test that claims to check the full `Problem` shape, and soften the claim in the impl record if they are not added.

F3 and F5 are optional. F6 needs nothing.
