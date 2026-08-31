# `impl_auth_rate_limit` — closing the `POST /auth/login` 429 contract gap

## What this closes

`specs/shared/openapi.yaml` declares a `429 TooManyRequests` response on `POST /auth/login`
(`$ref: '#/components/responses/TooManyRequests'`, rendering `components.schemas.Problem` as
`application/problem+json`) but nothing in the repository implemented rate limiting anywhere.
Since `specs/shared/` is inherited verbatim by assessments #8/#9, that false promise would have
propagated to both. This pass makes the contract true for `apps/gateway` by implementing an
actual, route-scoped rate limit on that one route and confirming (per the "make code match the
contract" default, since the 429 declaration itself is correct) that no change to `openapi.yaml`
was needed.

## What was built

- **`apps/gateway/src/infrastructure/auth/login-throttle.config.ts`** — a plain config loader
  (`loadLoginThrottleConfig(env)`), matching this app's existing `sse.config.ts`/
  `issued-order-window.config.ts` shape: `GATEWAY_LOGIN_RATE_LIMIT` (default `10`) and
  `GATEWAY_LOGIN_RATE_WINDOW_MS` (default `60000`).
- **`apps/gateway/src/app.module.ts`** — imports `ThrottlerModule.forRootAsync({ useFactory: … })`
  (a `@Global()` Nest module, so its providers/`ThrottlerGuard` resolve anywhere in this app),
  configured with one named `'default'` throttler from `loadLoginThrottleConfig()`. **Not**
  wired as an `APP_GUARD` — deliberately, per the brief's scope bound (throttle `POST /auth/login`
  only, nothing else).
- **`apps/gateway/src/presentation/auth.controller.ts`** — `login()` gains
  `@UseGuards(ThrottlerGuard)`, applied at the method level only. `/auth/me`, the catalog routes,
  `/orders/stream` and every other route are untouched and stay unthrottled — confirmed by a
  dedicated test (below).
- **`apps/gateway/src/presentation/problem-json.filter.ts`** — a new, explicit branch classifying
  `ThrottlerException` (imported from `@nestjs/throttler`) to `{ status: 429, code:
  'TOO_MANY_REQUESTS', title: 'Too many requests', detail: 'Too many login attempts — try again
  later.' }`, placed **before** the generic `instanceof HttpException` fallback (`ThrottlerException`
  extends `HttpException`, so ordering matters — see "Trap 1" below).
- **`pnpm-workspace.yaml`** catalog — `"@nestjs/throttler": ^6.5.0`, with a comment stating what
  it is for and why route-scoped, not `APP_GUARD`.
- **`apps/gateway/package.json`** — `"@nestjs/throttler": "catalog:"` added to `dependencies`.
- **`.env.example`** — `GATEWAY_LOGIN_RATE_LIMIT=10` / `GATEWAY_LOGIN_RATE_WINDOW_MS=60000`
  documented in a new block under the existing "Gateway RPC / SSE tuning" section, with a comment
  on why the defaults are what they are.

## Package chosen and why

`@nestjs/throttler@6.5.0` — the current major at install time. Its `peerDependencies` accept
`@nestjs/common`/`@nestjs/core` `^11.0.0` (this repo pins `^11.2.1`) and `reflect-metadata`
`^0.2.0` (this repo pins `^0.2.2`), both already satisfied by the catalog with no version
conflict. `npm view @nestjs/throttler@latest peerDependencies` confirmed this before pinning.

## Default policy and reasoning

**10 attempts per 60-second window, tracked per client IP** (the guard's own default `getTracker`,
`req.ip`) — tight enough to blunt a naive credential-stuffing loop against the single
unauthenticated write route this API exposes, loose enough not to trip on ordinary use. Verified
against this repo's own suites specifically (not assumed): grepped every `.post('/auth/login')`
call site across `apps/gateway/src` and found a **maximum of 3 calls in a single integration spec
file** (`auth.integration.spec.ts`); every other integration spec file that logs in does so once.
Each integration spec file boots its own fresh `AppModule` (`bootGatewayTestApp` in
`test-support/gateway-app-test-harness.ts`), so the in-memory `ThrottlerStorage` — and therefore
the request budget — is per-file, never shared across files. The production default (10/60s) was
**never weakened** for this reason: no test needed it lowered.

For the one test that specifically proves the 429 path (`auth-rate-limit.integration.spec.ts`),
`GATEWAY_LOGIN_RATE_LIMIT`/`GATEWAY_LOGIN_RATE_WINDOW_MS` ARE set to a small test-only value (limit
`3`) — done deliberately, in that file only, via `process.env` set immediately before its own
`bootGatewayTestApp` call and cleared in its `afterAll`. This does **not** touch
`gateway-app-test-harness.ts`'s shared `pointEnvAtFixtures`/`clearEnv`, so it cannot affect any
other integration spec file's own fresh `AppModule` instance.

## Trap 1 — `classify()` and `ThrottlerException`

**Before this pass:** the package was not installed at all, so no code path existed. Simulated
against the class shape once installed: `ThrottlerException extends HttpException` with status
`429`, constructed as `super('ThrottlerException: Too Many Requests', 429)`. Had it been left
unhandled, it would have fallen all the way through `classify()`'s existing chain to the generic
`instanceof HttpException` branch (line ~121, pre-existing code): `status = 429` (correct, from
`exception.getStatus()`), `code = this.codeForStatus(429)` — which, notably, **already** returned
`'TOO_MANY_REQUESTS'` (this literal was already present in `codeForStatus`, apparently
anticipating this exact gap, but nothing ever threw a 429 to exercise it before this pass) — but
`title = exception.name` = the raw string `'ThrottlerException'`, and `detail` = the library's own
internal wording, `'ThrottlerException: Too Many Requests'`. That is a real information leak of
implementation detail into a public API response and inconsistent with every other branch's
human-readable `title`.

**After this pass:** an explicit branch, checked before the generic `HttpException` fallback,
returns a clean `title: 'Too many requests'` and `detail: 'Too many login attempts — try again
later.'`, with the same `code: 'TOO_MANY_REQUESTS'` and `status: 429`. Confirmed by
`maps a ThrottlerException (POST /auth/login rate limit) to 429 TOO_MANY_REQUESTS, never the
generic HttpException fallback` in `problem-json.filter.spec.ts`.

## Trap 2 — existing tests that log in a lot

Addressed above (default policy reasoning) — grepped every login call site in `apps/gateway/src`
and confirmed the max-per-file count (3) sits well under the unweakened production default (10).
`apps/web/e2e/global.setup.ts` (Playwright) logs in exactly once. No suite in this repository
needed its behaviour changed.

## Armed-deletion evidence

**Probe 1 — the guard itself.** Removed `@UseGuards(ThrottlerGuard)` from
`AuthController.login()`. Re-ran `apps/gateway/src/auth-rate-limit.integration.spec.ts` (real
HTTP via `supertest`, real NATS + real MongoDB via Testcontainers, the actual spawned-in-process
Gateway). The test named
`answers 429 application/problem+json, matching components.schemas.Problem, on the (4)th POST
/auth/login within the window` failed with:

```
AssertionError: expected 401 to be 429 // Object.is equality

- Expected
+ Received

- 429
+ 401

 ❯ src/auth-rate-limit.integration.spec.ts:74:28
```

Restored the decorator; re-ran the same file plus `auth.integration.spec.ts` — both green (8/8
tests).

**Probe 2 — the `classify()` branch.** Changed `if (exception instanceof ThrottlerException)` to
`if (false && exception instanceof ThrottlerException)` in `problem-json.filter.ts` (forcing the
code down through the generic `HttpException` fallback). Re-ran
`problem-json.filter.spec.ts`. The test named
`maps a ThrottlerException (POST /auth/login rate limit) to 429 TOO_MANY_REQUESTS, never the
generic HttpException fallback` failed with:

```
AssertionError: expected 'ThrottlerException' not to be 'ThrottlerException' // Object.is equality
 ❯ src/presentation/problem-json.filter.spec.ts:83:28
     81|     expect(body.code).toBe('TOO_MANY_REQUESTS');
     82|     expect(body.status).toBe(429);
     83|     expect(body.title).not.toBe('ThrottlerException');
       |                            ^
```

(Confirms `status`/`code` alone would have looked fine — the leaking `title` is the failure the
explicit branch specifically guards against, exactly the "silently wrong" risk the brief named.)
Restored the branch; re-ran `problem-json.filter.spec.ts` — green (13/13).

## New tests (and what each proves)

- `apps/gateway/src/infrastructure/auth/login-throttle.config.spec.ts` — defaults (10/60000) and
  env-var overrides for the config loader.
- `apps/gateway/src/presentation/problem-json.filter.spec.ts` — new case: `ThrottlerException` →
  `429`/`TOO_MANY_REQUESTS`, `application/problem+json`, and explicitly asserts `title`/`detail`
  never leak the raw exception class name/message (the exact failure Probe 2 armed).
- `apps/gateway/src/auth-rate-limit.integration.spec.ts` — real, spawned-in-process Gateway
  (Testcontainers NATS + MongoDB, `supertest` HTTP client only):
  - `GET /auth/me is never throttled by the login route's guard — the guard is route-scoped, not
    global` — logs in once, then calls `GET /auth/me` `limit + 2` times, all `200`. Proves the
    scoping requirement ("Apply throttling to `POST /auth/login` ONLY").
  - `answers 429 application/problem+json, matching components.schemas.Problem, on the (4)th
    POST /auth/login within the window` — the real 429 proof (Probe 1's target). Asserts status
    `429`, `Content-Type: application/problem+json`, `code: 'TOO_MANY_REQUESTS'`,
    `status: 429`, a non-empty `correlationId`, and a string `occurredAt` — the full
    `components.schemas.Problem` shape every other error on this API produces.

No `R<n>` in `specs/shared/test-matrix.md` maps to this gap — checked directly
(`grep -in "429\|throttl\|rate.limit\|TooManyRequests" specs/shared/test-matrix.md` returns
nothing) and confirmed the matrix's own `R1`–`R62` range has no row for it. This is a
contract-implementation gap closure outside the numbered requirement set, not a spec'd feature, so
no `test-matrix.md` row exists to flip from `TODO`.

## Verified

- `pnpm --filter @otc/gateway run typecheck` — exit 0.
- `pnpm lint` (whole repo) — exit 0.
- `apps/gateway` unit suite (`npx vitest run`) — 31 test files, 126 tests, all green, including
  the two new unit files.
- `apps/gateway` full integration suite (`npx vitest run --config vitest.integration.config.mts`,
  real Testcontainers) — 11 test files, 50 tests, all green (253s), including
  `auth-rate-limit.integration.spec.ts` and the pre-existing `auth.integration.spec.ts` unmodified
  and unaffected.
- `pnpm quality` (whole repo: lint + typecheck + `test:coverage` for every workspace) — exit 0.
  Gateway coverage: 93.24% statements / 74.88% branches / 95.74% functions / 94.35% lines — well
  above the ≥60% overall gate (the ≥80% domain-layer gate is unaffected: this feature added no
  `domain/` code, by design — rate limiting is an infrastructure/presentation concern, not a
  domain rule).
- `./init.sh` — exit 0 (environment/state coherent; the only `[WARN]`s are the expected
  "uncommitted changes mid-session" and "run `pnpm test` before closing" notes, not failures).
- Both armed deletions (above) — each watched fail with its verbatim message, then restored and
  re-verified green.

## What was deliberately not done

- **`specs/shared/openapi.yaml` was not touched.** Per the brief's own instruction, the existing
  `429`/`TooManyRequests` declaration on `POST /auth/login` was read closely and found genuinely
  correct — the gap was purely on the implementation side, so the fix makes the code match the
  contract, not the other way around.
- **No other route was throttled.** `/auth/me`, the catalog routes and `/orders/stream` are
  confirmed untouched by a dedicated test, per the brief's explicit scope bound.
- **`README.md` was found already modified** (a "Scaling and production extensions" section,
  pre-existing on disk before this session started, unrelated to this change — confirmed via
  `git diff README.md`, not authored by this pass). Left untouched, per the brief's scope bound
  (`Do NOT touch: … README.md`) and CLAUDE.md's leader-only-edits rule for files outside
  `apps/`/`packages/`.

---

## Round 2 — review fixes (F1–F4; F5 left untouched, `specs/shared/` owned by `spec_author`)

Full verdict read first: `progress/review_auth_rate_limit.md`. One blocking defect (F1); F2–F4
were the review's own "recommended before re-review" list. F5 (`Retry-After` in `openapi.yaml`)
and F6 (an unreachable `afterAll` ordering fragility) were explicitly out of scope for this round
and untouched.

### F1 (blocking) — `loadLoginThrottleConfig` now validates, never silently accepts `NaN`/zero/negative

**What changed.** `apps/gateway/src/infrastructure/auth/login-throttle.config.ts` gained a
`parsePositiveInteger(raw, fallback, variableName)` helper used for both `GATEWAY_LOGIN_RATE_LIMIT`
and `GATEWAY_LOGIN_RATE_WINDOW_MS`. A value is accepted only if `Number(raw)` is finite, an
integer, and `>= 1`. Anything else — absent value aside, which still uses the default silently, as
before — is rejected: the loader logs a `console.warn(JSON.stringify({level:'warn', code:
'INVALID_LOGIN_THROTTLE_CONFIG', message, variable, rawValue, fallback}))` line (the same
`console.<level>(JSON.stringify(...))` shape `problem-json.filter.ts` already establishes for this
app's structured logging) and returns the documented default.

**Behaviour chosen and why: fall back + log, not fail-fast-at-boot.** The review explicitly asked
for one of the two, picked deliberately. Fail-fast was rejected because it would let one malformed
rate-limit knob take down the ENTIRE Gateway's boot — every route, not just login — which is a
disproportionate blast radius for a single misconfigured `.env` value in a demo/assessment
deployment with no orchestrator-level config validation gate. Fall back + log preserves
availability of the other 20+ routes while still making the misconfiguration **loud**: a
`console.warn` structured line naming the exact variable, the rejected raw value and the fallback
applied, which is the same visibility this repo's own structured-logging convention already gives
every other error path (R58's "every line carries enough to diagnose it" spirit, extended here to
a boot-time config warning rather than a request-time error). This is honest about the trade-off:
a deployer who never looks at logs will not notice a malformed value was rejected — but they were
equally not going to notice a `NaN` silently disabling the guard either, and now at least the
system stays SAFE (defaults hold) rather than FAILING OPEN (no throttling) or FAILING CLOSED (login
bricked) in the two ways the review measured.

**Every measured wrong answer reverified against the fix, by direct calculation through the new
`parsePositiveInteger`:**

| raw value | old behaviour (measured by review) | new behaviour |
|---|---|---|
| `"abc"` | `NaN` → guard never throttles (25/25 → 200) | rejected, logs, falls back to `10` |
| `"0"` | first request 429, login bricked | rejected, logs, falls back to `10` |
| `" "` | same as `"0"` | rejected, logs, falls back to `10` |
| `"-5"` | first request 429, login bricked | rejected, logs, falls back to `10` |
| `""` | `{limit:0, ttlMs:0}` — a third wrong answer (zero TTL masks zero limit) | BOTH rejected independently, BOTH logged, BOTH fall back (`10`/`60000`) |
| `"3.5"` | (not explicitly measured by the review, but the same bare-`Number` bug) | rejected (not an integer), logs, falls back |

**New tests** — `apps/gateway/src/infrastructure/auth/login-throttle.config.spec.ts`:

- `malformed GATEWAY_LOGIN_RATE_LIMIT — falls back to the default AND logs why (F1)` —
  parameterised (`it.each`) over exactly the five values the review named (`"abc"`, `"0"`, `""`,
  `" "`, `"-5"`) plus `"3.5"`; each asserts the fallback value, that `console.warn` was called
  exactly once, and the full shape of the logged JSON line (`level`, `code`, `variable`,
  `rawValue`, `fallback`, and that `message` names the offending variable).
- `malformed GATEWAY_LOGIN_RATE_WINDOW_MS falls back to the default AND logs why (F1)` — the same
  proof for the window variable independently.
- `an empty string for BOTH variables falls back to BOTH documented defaults, never a zero limit
  masked by a zero ttl (F1)` — the specific third wrong answer the review measured (`""` on both
  vars simultaneously), asserting both fall back independently and both log (`toHaveBeenCalledTimes(2)`).
- `never logs a warning for a valid, present value` — the negative case, so the warning path
  itself cannot be vacuously always-on.

**Armed-deletion evidence.** Replaced the validation `if` block with the exact pre-fix shape
(`const parsed = Number(raw); return parsed;` — no check, no log) and re-ran
`login-throttle.config.spec.ts`. 8 of 11 tests failed, one per malformed-input case, each with the
exact wrong value now flowing straight through — reproducing every row the review measured,
verbatim:

```
FAIL … malformed GATEWAY_LOGIN_RATE_LIMIT … > "abc" — non-numeric
AssertionError: expected NaN to be 10 // Object.is equality
 ❯ src/infrastructure/auth/login-throttle.config.spec.ts:43:28

FAIL … "0" — zero would brick login on the very first request
AssertionError: expected +0 to be 10 // Object.is equality

FAIL … "" — empty string
AssertionError: expected +0 to be 10 // Object.is equality

FAIL … " " — a stray space
AssertionError: expected +0 to be 10 // Object.is equality

FAIL … "-5" — negative would brick login on the very first request
AssertionError: expected -5 to be 10 // Object.is equality

FAIL … "3.5" — not an integer
AssertionError: expected 3.5 to be 10 // Object.is equality

FAIL … malformed GATEWAY_LOGIN_RATE_WINDOW_MS falls back to the default AND logs why (F1)
AssertionError: expected NaN to be 60000 // Object.is equality

FAIL … an empty string for BOTH variables falls back to BOTH documented defaults, never a zero limit masked by a zero ttl (F1)
AssertionError: expected +0 to be 10 // Object.is equality
```

Restored the validation block; re-ran the same file — 11/11 green.

### F2 (recommended) — corrected the "tracked per client IP" claim

**What was wrong.** `.env.example` and this file's Round 1 text both stated the limit is "tracked
per client IP" without qualification. `ThrottlerGuard`'s default tracker genuinely is `req.ip`, but
the Gateway does not enable Express `trust proxy` and receives no `X-Forwarded-For` — and
`apps/web/server/api/auth/login.post.ts` calls the Gateway server-side from the Nuxt BFF, so every
browser login shares the single `otc-web` container's IP. The same collapse applies to all four
n8n workflows sharing the `otc-n8n` container IP. The review's own framing is correct: this is a
budget shared per CALLER, not per end user, for both of this system's own real clients.

**What changed.** `.env.example`'s `GATEWAY_LOGIN_RATE_LIMIT`/`GATEWAY_LOGIN_RATE_WINDOW_MS`
comment block was rewritten to state the actual tracking behaviour (`req.ip`, no `trust proxy`, no
XFF), name both the web BFF and n8n as callers that share one bucket, and note the interaction
with `ORDER_GENERATOR_INTERVAL_SECONDS` — safe at the shipped 45s default (~2 logins/min against a
10/min shared budget) but capable of exceeding the budget at a low enough interval, with no `429`
handling on the generator's retry path. `login-throttle.config.ts`'s own inline comment was
updated to point at `.env.example` for the full account rather than repeating the now-corrected
"per client" language. **Not implemented, deliberately, per the explicit instruction:** `trust
proxy` or `X-Forwarded-For` forwarding from the BFF — that is a design decision left for the human
gate, not made in this pass. `apps/gateway/src/auth-rate-limit.integration.spec.ts`'s header
comment was also corrected to say "per-CALLER-IP", not "per-client", for the same reason.

### F3 (recommended) — decoupled the integration test's two `it` blocks

**What was wrong.** The second test's request count (`TEST_LOGIN_RATE_LIMIT - 1` further attempts)
was only correct because the FIRST test had already consumed exactly one hit of the same per-app
throttler bucket — an order dependency the file's own comment even named but did not remove.

**What changed.** Replaced the precomputed count with a bounded loop (`MAX_ATTEMPTS =
TEST_LOGIN_RATE_LIMIT + 5`) that sends `POST /auth/login` repeatedly until it OBSERVES a `429`
(captured, not counted-to), asserting `401` on every attempt along the way and asserting the loop
did find a `429` within the bound before checking its shape. This test now passes regardless of
how many hits any earlier test in the file already spent — reordering, skipping, or running it in
isolation (`.only`) all still work, which is what F3 asked for.

### F4 (recommended) — the integration test now positively asserts the full `Problem` shape

**What was wrong.** The test was titled "…matching `components.schemas.Problem`…" but only
asserted `status`, `content-type`, `code`, `status` (again), `correlationId` and `typeof
occurredAt`. Nothing positively asserted `title`, `detail` or `type` — so an edit that blanked
`title` would leave the whole suite green. This file's own Round 1 record overstated the coverage
at the line the review cited.

**What changed.** Added `expect(limited.body.type).toBe('about:blank')`,
`expect(limited.body.title).toBe('Too many requests')` and
`expect(limited.body.detail).toBe('Too many login attempts — try again later.')` to the same test,
alongside the pre-existing assertions — now genuinely covering every field
`components.schemas.Problem` names (`type`, `title`, `status`, `detail`, `code`, plus the optional
`correlationId`/`occurredAt` this API always populates). The overstated claim in this file's Round
1 text (originally at "what was verified") is corrected by this Round 2 section superseding it;
the claim now reflects what the file in fact asserts.

### Re-verification after all four fixes

- `pnpm --filter @otc/gateway run typecheck` — exit 0.
- `pnpm lint` (whole repo) — exit 0.
- `apps/gateway` unit suite (`npx vitest run`) — 31 test files, **135 tests** (was 126; +9 new F1
  cases), all green.
- `apps/gateway` full integration suite (`npx vitest run --config vitest.integration.config.mts`,
  real Testcontainers) — 11 test files, 50 tests, all green (281s), including the F3/F4-revised
  `auth-rate-limit.integration.spec.ts`.
- `pnpm quality` (whole repo) — exit 0. Gateway coverage: 93.37% statements / 75.21% branches /
  95.77% functions / 94.46% lines — still well above the ≥60% overall gate; no `domain/` code was
  added, so the ≥80% domain gate remains unaffected.
- `./init.sh` — not re-run this round (no environment/state-affecting change since Round 1's
  clean run; only source/test/doc edits).
- F1's armed deletion (above): 8/11 named tests failed with the verbatim messages quoted, then
  restored and re-verified green (11/11). F1 is the only new armed-deletion probe this round — F3
  and F4 are test-quality fixes with no corresponding "fact emitted/suppressed" branch to arm; F2
  is a documentation-only change.
- `git status --porcelain` — unchanged in shape from Round 1 (same tracked-modified files plus the
  same three new source files, plus the two `progress/` files); nothing staged, no commit, no
  push, per instruction.

## Round 3 — regenerate the contracts (F5) and close R63's two test gaps

Follow-up to the spec pass recorded in `progress/spec_auth_rate_limit_contract.md`, which added a
`Retry-After` header to `components.responses.TooManyRequests` in `specs/shared/openapi.yaml` and
minted **R63** (`specs/shared/requirements.md` §8.1, `specs/shared/test-matrix.md` §8.1, row left
`TODO` on purpose — see that document's open point 11). Two tasks, both already decided at the
human gate; nothing here is a design decision of mine.

### Task 1 — regenerate `packages/contracts`

Before: `pnpm --filter @otc/contracts check` failed with `contracts:check FAILED — committed
generated files are stale`, reporting exactly the 14-line diff the spec pass had already measured
and reported in its open point 9.

Ran `pnpm --filter @otc/contracts run generate`, then re-ran `pnpm --filter @otc/contracts check`
— now `contracts:check OK — committed generated files match a fresh pnpm contracts:generate run.`

The resulting `git diff -- packages/contracts/src/generated/` touches **only**
`packages/contracts/src/generated/openapi.types.ts` (`asyncapi.types.ts` unchanged, confirming
nothing in the AsyncAPI half of the contract was disturbed), and its entire content is:

```diff
-        /** @description Rate limited. */
+        /**
+         * @description The client exceeded the rate limit of the endpoint it called. The
+         *     request was **not** applied and no fact was emitted; the client may
+         *     retry once the interval named by `Retry-After` has elapsed.
+         */
         TooManyRequests: {
             headers: {
+                /**
+                 * @description How long the client must wait before retrying, as a whole number of
+                 *     **seconds**. Delta-seconds only: the HTTP-date form RFC 9110 also
+                 *     permits is deliberately **not** used by this API, so a client may
+                 *     parse this header as an integer without branching on its form. The
+                 *     value is the remaining lifetime of the limiter's current window;
+                 *     the window length itself is per-assessment configuration and is
+                 *     deliberately not fixed by this contract.
+                 */
+                "Retry-After": number;
                 [name: string]: unknown;
             };
```

Exactly the addition the brief predicted — `"Retry-After": number;` under
`components["responses"]["TooManyRequests"]["headers"]`, non-optional because `required: true` in
the spec — plus the description comment carried over from the YAML (`openapi-typescript` always
emits the source `description` as a JSDoc block; that half of the diff is not a separate change,
it is the same property). No hand-editing of any generated file; the generator alone produced this.
Nothing beyond what the brief named, so nothing to stop and report.

### Task 2 — close R63's two test gaps in `apps/gateway/src/auth-rate-limit.integration.spec.ts`

Rewrote the file (only file touched for this task). Kept the boot/teardown scaffolding
byte-identical (`bootGatewayTestApp`, `TEST_LOGIN_RATE_LIMIT = 3`, the same env-var overrides).
Retitled all three `it` blocks to the **literal** case names `test-matrix.md` §8.1 gives
`api/login-rate-limit.spec`, so the matrix's file›case citation resolves on the case name, not a
paraphrase of it:

1. `"a client refused by the login limit continues to be served on every other endpoint — the
   limit is scoped to the login route, never global"` — the pre-existing route-scoping case
   (previously titled `"GET /auth/me is never throttled…"`), logic untouched per the brief
   ("already correct"). Kept **first** in file order: it is the only case that needs a `POST
   /auth/login` to actually succeed (200) before the throttler bucket the whole file shares
   (review finding F3) gets driven past its limit by the other two cases — ordering the file this
   way is a structural constraint of the shared bucket, not the "silent arithmetic on a limit
   constant" F3 forbade, and it reproduces the ordering the original file already had.
2. `"exceeding the login rate limit answers 429 with an \`application/problem+json\` body
   matching \`components.schemas.Problem\` and a \`Retry-After\` header carrying a whole number of
   seconds, and issues no token"` — the pre-existing `429`/`Problem`-shape case, with two things
   newly closed: a **positive** `Retry-After` assertion (`/^\d+$/` shape check — rejects the RFC
   9110 HTTP-date alternative the contract deliberately excludes, since a date string contains
   letters/commas a pure-digit regex never matches — then `Number.isInteger(...)` and `>= 0`), and
   `expect(limited!.body.accessToken).toBeUndefined()` for "issues no token". Still a bounded loop
   (`MAX_ATTEMPTS = TEST_LOGIN_RATE_LIMIT + 5`) that hammers until it *observes* a 429, per F3.
3. `"the same 429 is returned for valid and for invalid credentials once the limit is exceeded, so
   the refusal reveals nothing about the credentials"` — **new case**, R63(c). Hammers with wrong
   credentials in the same bounded-loop-until-observed-429 shape (independent of whatever state
   the bucket is already in when the case starts — no arithmetic on a precomputed count), then
   sends a request carrying the **correct** operator credentials and asserts it is *also* `429`
   (`content-type: application/problem+json`, `code: 'TOO_MANY_REQUESTS'`, no `accessToken`),
   proving the refusal does not depend on credential validity.

### Verified run — `pnpm --filter @otc/gateway run test:integration`, real Testcontainers

`vitest run --config vitest.integration.config.mts src/auth-rate-limit.integration.spec.ts
--reporter=verbose`:

```
✓ … > a client refused by the login limit continues to be served on every other endpoint — the limit is scoped to the login route, never global   75ms
✓ … > exceeding the login rate limit answers 429 with an `application/problem+json` body matching `components.schemas.Problem` and a `Retry-After` header carrying a whole number of seconds, and issues no token   20ms
✓ … > the same 429 is returned for valid and for invalid credentials once the limit is exceeded, so the refusal reveals nothing about the credentials   9ms

Test Files  1 passed (1)
     Tests  3 passed (3)
```

Also ran the file through the *repo* `pnpm --filter @otc/gateway run test:integration` (no path
filter — the full gateway integration config, real MongoDB + NATS via Testcontainers): 11 test
files, 51 tests, all green, 257s.

### Armed-deletion evidence for the `Retry-After` assertion

Per CLAUDE.md's fact-emission-guard rule and this brief's explicit instruction. `Retry-After` on
the `429` is emitted by `@nestjs/throttler`'s `ThrottlerGuard` itself (no app-code line sets it —
`grep`-confirmed the only `res.setHeader('Retry-After', …)` in `apps/gateway/src` is
`orders.controller.ts`'s unrelated `202` on `GET /orders/{id}`), so the emission path is a
third-party library, not something this task may edit. Armed the deletion on **the assertion's
target** instead — the sanctioned alternative the brief names — by temporarily changing the header
lookup in case 2 from `limited!.headers['retry-after']` to
`limited!.headers['retry-after-DELETED']` (file copied to the scratchpad first, restored via `cp`
afterward, `diff` confirmed byte-identical, `md5sum` recorded:
`b460ecbf4516b3587891ee0c396ed03c`).

Re-ran the single file. **Named test failed**:

```
FAIL  src/auth-rate-limit.integration.spec.ts > Gateway POST /auth/login rate limit — 429 application/problem+json (openapi.yaml TooManyRequests, R63) > exceeding the login rate limit answers 429 with an `application/problem+json` body matching `components.schemas.Problem` and a `Retry-After` header carrying a whole number of seconds, and issues no token
AssertionError: expected undefined to be defined
 ❯ src/auth-rate-limit.integration.spec.ts:123:30
    121|     // letters and commas that pure digits never do.
    122|     const retryAfterHeader = limited!.headers['retry-after-DELETED'];
    123|     expect(retryAfterHeader).toBeDefined();

Tests  1 failed | 2 passed (3)
```

Restored the file (`cp` from the scratchpad backup), confirmed byte-identical via `diff`, and
re-ran the same file: 3/3 green again.

### What I deliberately left alone

- `specs/shared/**` — untouched, per scope. The R63 row in `test-matrix.md` §8.1 stays `TODO`;
  flipping it is the spec author's call, not mine, per the brief.
- `apps/orders/**` — untouched, including `test-matrix-guard.spec.ts`, which another agent is
  concurrently editing (its `git status` entry shows as modified but I made no change to it).
- `feature_list.json`, `README.md`, and every `progress/` file other than this one — untouched.
- `packages/contracts/src/generated/asyncapi.types.ts` — regenerated but byte-identical (confirmed
  via the `git diff --stat` showing only `openapi.types.ts` changed), so nothing to report there.
- The `it` title mismatch between the matrix's stated file citation (`api/login-rate-limit.spec`)
  and this file's actual path (`auth-rate-limit.integration.spec.ts`) — the brief's scope
  explicitly restricts me to editing this one file by its existing name, so I retitled the **case
  names** verbatim and left the file's own name and location as they were; reconciling the file
  path in the citation, if wanted, is a `specs/shared/` edit outside this brief.
- F1/F2 (from `progress/review_auth_rate_limit.md`) were already resolved before this round
  started (`login-throttle.config.ts` already validates `GATEWAY_LOGIN_RATE_LIMIT` — confirmed by
  reading the file) — not this round's concern, noted only for continuity.

### Final verification

- `pnpm --filter @otc/contracts check` — exit 0 (`contracts:check OK`).
- `pnpm quality` (whole repo) — **exit 0**, all packages including `apps/orders` (its coverage
  report and test run both completed with no failures logged, and no `test-matrix-guard`-related
  failure appeared in the output — the concurrent agent's row-count fix was evidently already
  landed or in a non-failing state at the time this ran).
- `git status --porcelain` — my touched files are exactly
  `packages/contracts/src/generated/openapi.types.ts` (modified, generator output only) and
  `apps/gateway/src/auth-rate-limit.integration.spec.ts` (untracked, pre-existing from Round 1,
  rewritten this round). `apps/orders/src/test-matrix-guard.spec.ts` shows modified from the other
  agent's in-flight work — not touched by me. Nothing staged, no `git commit`, no `git push`.
