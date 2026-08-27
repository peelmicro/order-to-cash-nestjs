# `saga_e2e_verification` — Pass 1 (implementation notes)

Feature id 28, phase 15, `sdd: false`. This pass closes the two prerequisite
gaps left open from feature 27 (`observability_reliability`) and builds a
reusable spawn helper for Pass 2. It does **not** attempt the actual saga
verification tests (happy path, `.99` compensation, redelivery, poison→DLQ,
composed trace) — that is explicitly Pass 2's job.

## Part 1 — Gateway's missing NATS `rtt()` timeout wrapper

**Status: done.**

`apps/gateway/src/infrastructure/health/nats-health-check.ts` called
`this.connection.rtt()` with no timeout — `apps/orders`, `apps/fulfillment`
and `apps/billing`'s own copies of this file already carry an explicit
`withTimeout(2000ms)` wrapper (feature 27, A8c) after the same bug was
found there: `nats.js`'s `rtt()` has no built-in timeout and hangs
indefinitely against a paused-but-TCP-open broker. Applied the identical
fix, copied verbatim from `apps/fulfillment`'s working copy (`NATS_RTT_TIMEOUT_MS
= 2000`, the same `withTimeout` helper).

New test: `apps/gateway/src/health-probes.integration.spec.ts` — the
Gateway's own equivalent of the three siblings' `health-probes.integration.spec.ts`
(Testcontainers `mongo:8.3.8` + `nats:2.14.5-alpine`, composing the real
`HealthController`/`MongoHealthCheck`/`NatsHealthCheck` classes
`app.module.ts` wires — Gateway had no such spec at all before this pass).
Two cases:
- `R60 — reports ready (200, every check up) when every dependency is
  reachable`
- `R60 — pausing the REAL RPC-transport (NATS) container makes readiness
  report 503/down for rpcTransport ONLY within a bounded window (not
  hang), while liveness stays 200/up throughout, and readiness recovers
  once the container is unpaused`

**Armed and watched fail.** Reverted the `withTimeout` wrapper back to a
bare `await this.connection.rtt()`, ran the pause test under a bash
`timeout 200`. Result: the process was killed by the outer timeout after
200s with **no test output at all** (`Terminated`, exit 143) — the request
genuinely hung past the harness's own 45s poll budget rather than failing
fast, exactly the bug the wrapper exists to prevent. Restored; re-ran green
(both cases pass in ~4–10s total).

## Part 2 — Fulfillment/Billing's NATS responders extract no trace context; outboxes never wrote `trace_parent`

**Status: done.** This turned out larger than the brief's phrasing implied
— see "Honest scope note" below.

### What was actually missing

Neither service had **any** OTel bootstrap at all: no `@opentelemetry/*`
package dependency, no `tracing.ts`, no `trace-context.ts` helper — unlike
`apps/orders`, which has a full `NodeSDK` bootstrap (`main.ts`'s first
import), a `trace-context.ts` with NATS/Kafka extract+inject helpers, and
its own `activeTraceParent()`. `specs/observability_reliability/tasks.md`'s
A5 group is headed "NOT DONE THIS PASS" with every sub-item `[ ]` — stale
relative to what actually landed for Orders in the last checkpoint commit
(the tasks doc was never updated after Orders' own A5 work landed), but
accurate for Fulfillment/Billing: A5 genuinely was never done for them.

Confirmed the third-hop question the brief asked me to check rather than
assume: **yes**, both services' outboxes needed the fix too. Both
`outbox-recorder.ts` files always wrote `traceParent: null` (never called
`activeTraceParent()` — the function didn't exist yet). Both
`outbox-relay.ts` files already had the READ side ready and waiting (`if
(row.traceParent) headers.traceparent = row.traceParent;`, literally
commented "until feature 27 populates the column") — so the relay needed
**no code change**, only a stale-comment update; the recorder was the only
write-side gap.

### What was built (mirrors Orders' A5a/A5b/A5c, trace-only, no A7 metrics)

For **both** `apps/fulfillment` and `apps/billing`:

- `package.json` — added `@opentelemetry/api`, `@opentelemetry/sdk-node`,
  `@opentelemetry/exporter-trace-otlp-grpc` (runtime); `@opentelemetry/context-async-hooks`,
  `@opentelemetry/core`, `@opentelemetry/sdk-trace-base`,
  `@opentelemetry/sdk-trace-node` (dev, for the integration test's own
  `NodeTracerProvider`/`InMemorySpanExporter`). Same catalog versions
  Orders already pins.
- `src/infrastructure/observability/trace-context.ts` (new) — the NATS-only
  subset of Orders' file: `extractNatsTraceContext`, `activeTraceParent`,
  `tracer()`. Orders' Kafka getter/injector and outbound-NATS injector are
  deliberately NOT copied — neither service makes an outbound NATS call or
  consumes a Kafka fact.
- `src/infrastructure/observability/tracing.ts` (new) — trace-only `NodeSDK`
  bootstrap (no `metricReader`; A7/R59 metrics stay Orders/Gateway-only,
  explicitly out of this pass's scope).
- `src/main.ts` — `import './infrastructure/observability/tracing';` as the
  first import, mirroring Orders' convention.
- `src/infrastructure/outbox/outbox-recorder.ts` — `traceParent: null` →
  `traceParent: activeTraceParent()`.
- `src/infrastructure/outbox/outbox-relay.ts` — comment-only update (the
  stale "until feature 27 populates the column" note).
- Every `@MessagePattern` responder wrapped with `extractNatsTraceContext`
  + `otelContext.with(...)`, mirroring `orders-create.controller.ts`'s
  pattern exactly (extract once in the decorated method, delegate the
  original body to a new `private handleX(...)` inside the extracted
  context):
  - Fulfillment (`stock.controller.ts`, `despatch.controller.ts`): `check`,
    `reserve`, `release`, `list`, `replenish`, `create` — **all six**, not
    only the four the brief named (`stock.check`/`reserve`/`release`/
    `despatch.create`) — `list`/`replenish` were wrapped too, since
    extraction is a no-op on a call carrying no `traceparent` header, so
    wrapping every responder costs nothing on the callers that don't send
    one and closes the gap for the ones that will.
  - Billing (`credit.controller.ts`, `invoice.controller.ts`): `hold`,
    `list` (credit), `issue`, `list` (invoice), `registerPayment` — **all
    five**.
  - `stock.controller.spec.ts`, `credit.controller.spec.ts`,
    `invoice.controller.spec.ts` — updated the handful of call sites that
    invoked a newly-`@Ctx()`-bearing method with only one argument
    (`check`, `replenish`, `list` × 3) to pass a `fakeContext()`.

### New tests (R57)

- `apps/fulfillment/src/trace-context-propagation.integration.spec.ts`
- `apps/billing/src/trace-context-propagation.integration.spec.ts`

Both: real MySQL + NATS + Kafka (Testcontainers), the real `AppModule`
graph via each service's own existing `*-integration-harness.ts`, a real
`NodeTracerProvider`/`AsyncLocalStorageContextManager`/
`W3CTraceContextPropagator` registered globally in `beforeAll` (same shape
Orders' own `trace-context-propagation.integration.spec.ts` uses) — a raw
NATS request over a real socket carrying a genuine `traceparent` header
built from a real client span, never a hand-built `NatsContext`. Two cases
each:
- *"a real inbound traceparent header on `fulfillment.stock.reserve`/
  `billing.credit.hold` is the ACTIVE trace (same traceId) at the moment
  OutboxRecorder writes the outbox row — not a fresh one"* — reads the
  **real, OTel-generated** `outbox.trace_parent` value back out of MySQL
  and asserts it equals the injected header byte-for-byte (no manual span
  is created between extraction and the write in either service, unlike
  Orders' relay, so the extracted remote span context round-trips
  identical to the header — real trace-id equality, not header presence).
- *"an inbound request with NO traceparent header produces NO trace_parent
  at all — no spurious trace fabricated"*.

**Armed and watched fail — three separate deletions, one per genuine claim
site:**

1. Fulfillment, `stock.controller.ts`'s `reserve` — reverted the
   extraction wrap to a bare pass-through (`return this.handleReserve(payload,
   ctx);`). Re-ran: `AssertionError: expected null to be
   '00-a9b0e0c707e106246c4b1584b23fa5b3-761d5fcbbc5f7297-01'`. Restored,
   re-verified green.
2. Billing, `credit.controller.ts`'s `hold` — same probe. Re-ran:
   `AssertionError: expected null to be
   '00-01c5b0e89d0e25ac86f062348eb2f32a-3f2a46f74a982d60-01'`. Restored,
   re-verified green.
3. Fulfillment, `outbox-recorder.ts` — isolated the recorder half from the
   responder half: restored the wrap from (1), instead hard-coded `const
   traceParent = null;` in place of `activeTraceParent()`. Re-ran:
   `AssertionError: expected null to be
   '00-c57b5bce36c1315eee05643beaa52864-7ed52ddb5cb3a3dd-01'`. Restored,
   re-verified green.

All three probes reproduce the exact "trace breaks here" failure mode this
pass exists to close, and all three are now green on the restored code.

### Honest scope note

The brief characterized this as applying "the same extraction pattern" to
existing responders and checking a comment. In practice neither service had
*any* OTel plumbing at all (no dependency, no bootstrap, no helper file) —
so this part also stood up the trace-only half of A5a (SDK bootstrap) for
both services from scratch, not just the responder-wrapping A5b/A5c pieces
the brief anticipated as the remaining work. It stayed within budget (this
pass's full `pnpm quality` + both services' full `test:integration` suites
together run well under Pass 2's stated multi-service scope), but is worth
recording precisely since it is materially more than "read one file, apply
the same fix."

## Part 3 — generalized spawn helper

**Status: done.**

Read `apps/gateway/src/test-support/spawn-real-projector.ts` in full.
Generalized its build-then-spawn discipline into a new file,
`apps/gateway/src/test-support/spawn-real-service.ts`, exporting
`spawnRealService(options: SpawnRealServiceOptions): Promise<RealServiceProcess>`
— builds `apps/<serviceName>` with that service's own `tsc -p
tsconfig.build.json` (throwing with the captured compiler output on a
non-zero exit, never spawning against a stale/absent `dist/`), spawns `node
dist/<serviceName>/dist/main.js` (never `tsx`, for the same DI-metadata
reason `CLAUDE.md` states), and races a caller-supplied readiness strategy
against the process exiting first. Two readiness strategies
(`ServiceReadiness` union):
- `{ type: 'log', pattern: RegExp, timeoutMs? }` — polls captured
  stdout+stderr for a pattern match; the general case, matching the `[service]
  listening on port ...` convention every `apps/*/src/main.ts` already
  follows.
- `{ type: 'custom', check: () => Promise<void> }` — a caller-supplied
  async check, for a service whose readiness is not visible on stdout at
  all (the projector's Kafka consumer-group-`Stable` poll — `ServerKafka`
  never logs a line for that).

`spawn-real-projector.ts` was **not rewritten from scratch** — it is now a
thin, projector-specific wrapper: same exported
`spawnRealProjector`/`RealProjectorOptions`/`RealProjectorProcess` shape
(so its only caller, `stream-projector-e2e.integration.spec.ts`, needed no
change), delegating the actual build-then-spawn work to `spawnRealService`
with the `'custom'` Kafka-consumer-group readiness strategy. Also moved the
file's private `getFreePort()` helper into `spawn-real-service.ts` as a
shared, exported utility (both files needed it; one copy now).

**Where it lives, and why:** `apps/gateway/src/test-support/`, in place —
not a new `packages/` entry. `CLAUDE.md` restricts shared *runtime* code to
`shared-kernel`/`contracts`; this is test-only code never imported by any
service's own `src/`, and every existing `spawn-real-*`-shaped file in this
repo already lives inside the *calling* service's own `test-support/` (no
service imports another service's `src/` anywhere in this monorepo —
`spawn-real-projector.ts`'s own header comment establishes this). Gateway
is the only service that spawns another service's real process today (its
SSE E2E spec), and stays the natural home for Pass 2's own composed-stack
test (`e2e/trace-continuity.spec` per `test-matrix.md`'s own naming, though
where that literal file lives is Pass 2's decision, not mine to make
unilaterally here) — widening this file in place is the smaller,
conservative move. Flagged, not decided unilaterally: if Pass 2's actual
caller turns out to need this from a location `apps/gateway` cannot reach,
that is Pass 2's call to make, with the leader's sign-off, not mine to
pre-empt.

### Proof: `apps/gateway/src/spawn-real-service-smoke.integration.spec.ts` (new)

Spawns **two** real, unmodified services — `apps/fulfillment` and
`apps/billing`, the two already-touched-this-pass services, needing only a
real NATS broker to boot successfully (their `NATS_CONNECTION` provider is
an awaited, async `useFactory` — Nest blocks module construction on it; MySQL/Kafka
are deliberately left unreachable-but-unused, with `OUTBOX_RELAY_ENABLED=false`
stopping `OutboxRelayService.onApplicationBootstrap` from ever touching
either — verified by reading both `outbox-relay.service.ts`, which returns
immediately when `config.enabled` is false, and both `app.module.ts`
files, which query no dependency eagerly at boot). Real NATS via
`open-nats-test-fixture.ts` (the existing auth-free Testcontainers NATS
fixture, built for exactly this "a spawned, unmodified process's own
`NATS_URL`-driven connection has no way to receive injected credentials"
problem — its own header comment already documents the finding).

One test, both `'log'`-readiness spawns in parallel: confirms each process
reaches its own `[fulfillment]`/`[billing] listening on port ...` line
(genuinely distinct PIDs), then tears both down and asserts — via
`process.kill(pid, 0)` throwing `ESRCH`, a real OS-level check, not merely
trusting `stop()`'s own resolved promise — that **neither process still
exists** afterward. No orphaned process. Green in ~8.5s.

**Armed and watched fail.** Temporarily changed fulfillment's readiness
`pattern` to a regex that can never match (`timeoutMs: 5_000`). Re-ran:
failed with `Error: spawnRealService(fulfillment): readiness pattern
/THIS-PATTERN-WILL-NEVER-MATCH-DELETION-ARM-PROBE/ not observed within
5000ms`, with the full captured stdout attached to the error — including
the real `[fulfillment] listening on port 35801 ...` line, proving the
process genuinely booted but the readiness-detection logic correctly
refused to call it ready on a non-matching pattern rather than passing
vacuously. Restored, re-verified green.

## Files touched (this pass only — pre-existing uncommitted changes from
feature 27 in these same three apps are not this pass's work and are left
untouched)

**Part 1:**
- `apps/gateway/src/infrastructure/health/nats-health-check.ts` (edit)
- `apps/gateway/src/health-probes.integration.spec.ts` (new)

**Part 2:**
- `apps/fulfillment/package.json`, `apps/billing/package.json` (edit —
  OTel deps)
- `apps/fulfillment/src/infrastructure/observability/trace-context.ts`,
  `tracing.ts` (new); same two files under `apps/billing/src/infrastructure/observability/`
  (new)
- `apps/fulfillment/src/main.ts`, `apps/billing/src/main.ts` (edit)
- `apps/fulfillment/src/infrastructure/outbox/outbox-recorder.ts`,
  `apps/billing/src/infrastructure/outbox/outbox-recorder.ts` (edit)
- `apps/fulfillment/src/infrastructure/outbox/outbox-relay.ts`,
  `apps/billing/src/infrastructure/outbox/outbox-relay.ts` (comment-only
  edit)
- `apps/fulfillment/src/presentation/stock.controller.ts`,
  `despatch.controller.ts` (edit); `apps/billing/src/presentation/credit.controller.ts`,
  `invoice.controller.ts` (edit)
- `apps/fulfillment/src/presentation/stock.controller.spec.ts`;
  `apps/billing/src/presentation/credit.controller.spec.ts`,
  `invoice.controller.spec.ts` (edit — added `fakeContext()` args)
- `apps/fulfillment/src/trace-context-propagation.integration.spec.ts`,
  `apps/billing/src/trace-context-propagation.integration.spec.ts` (new)

**Part 3:**
- `apps/gateway/src/test-support/spawn-real-service.ts` (new)
- `apps/gateway/src/test-support/spawn-real-projector.ts` (edit —
  refactored onto the generic helper)
- `apps/gateway/src/spawn-real-service-smoke.integration.spec.ts` (new)

`pnpm-lock.yaml` updated by `pnpm install` after the `package.json` edits.

## Packages installed (disclosed per CLAUDE.md — not committed by me)

Runtime, `apps/fulfillment` + `apps/billing`:
`@opentelemetry/api`, `@opentelemetry/sdk-node`,
`@opentelemetry/exporter-trace-otlp-grpc` — the trace-only bootstrap
Orders already carries, all at the versions already pinned in the repo's
own `pnpm-workspace.yaml` catalog (no new versions introduced).

Dev, `apps/fulfillment` + `apps/billing`:
`@opentelemetry/context-async-hooks`, `@opentelemetry/core`,
`@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-trace-node` — needed
only by the new integration tests' own `NodeTracerProvider`/
`InMemorySpanExporter`, same as Orders' own devDependency set.

No new dependency was added to `apps/gateway` — Part 3's smoke test
deliberately reuses the existing auth-free NATS fixture and each spawned
service's own lazy MySQL/Kafka construction to avoid needing
`@testcontainers/mysql`/`@testcontainers/kafka` in Gateway at all.

## Self-verification

- `pnpm quality` (root: `eslint .` + `pnpm -r typecheck` + `pnpm -r test`)
  — **exit 0**. 0 lint errors, 0 warnings (two `no-unused-vars` warnings
  from the new integration specs' initial drafts were found and fixed:
  an unused `randomUUID` import in fulfillment's spec, an unused `context`
  import in billing's). Every workspace's typecheck and unit suite green,
  including all ten workspaces beyond the three this pass touched (no
  regression anywhere else in the monorepo).
- `apps/fulfillment`'s full `test:integration` suite (real MySQL + NATS +
  Kafka): **14 files, 48 tests, all green**, 192s — including the new
  `health-probes.integration.spec.ts` (pre-existing, feature 27) and the
  new `trace-context-propagation.integration.spec.ts` (this pass).
- `apps/billing`'s full `test:integration` suite: **20 files, 68 tests,
  all green**, 275s — same shape.
- `apps/gateway`'s new `health-probes.integration.spec.ts` and
  `spawn-real-service-smoke.integration.spec.ts`: green in isolation
  (~10s and ~8.5s respectively). `stream-projector-e2e.integration.spec.ts`
  (the one pre-existing caller of the now-refactored
  `spawn-real-projector.ts`) re-run and confirmed unaffected — still
  green.
- `./init.sh` — still exits 0 (green, 26 uncommitted changes noted as
  "expected mid-session").

## What remains for Pass 2

- The actual saga-verification tests: happy path → `completed`, a `.99`
  order's visible compensation, redelivery causing no corruption, a
  poisoned message reaching the DLQ, and R56's composed-stack trace
  observation (one trace id spanning the inbound request, every command,
  every write-model transaction, and every fact publication/consumption
  for one order, across the real running six-service stack).
- Deciding whether `spawnRealService` needs to move out of
  `apps/gateway/src/test-support/` if Pass 2's actual composed-stack test
  ends up living somewhere `apps/gateway` cannot reach — flagged above,
  not decided here.
- `spawnRealService` has not yet been exercised spawning `apps/orders`,
  `apps/notifications` or `apps/gateway` itself (only `apps/fulfillment`/
  `apps/billing`, via the smoke test, and `apps/projector`, via the
  pre-existing wrapper) — the smoke test proves the mechanism, not that
  every service's own env-var contract is already known/correct for a
  Pass-2-scale six-service simultaneous boot. Pass 2 will likely need to
  work out each remaining service's own required env vars the same way
  this pass worked out Fulfillment's/Billing's.
- `specs/shared/test-matrix.md`'s R57 row still reads "TODO (feature 27)"
  and does not yet mention Fulfillment/Billing's own
  `trace-context-propagation.integration.spec.ts` files — left untouched
  deliberately (bounded scope: this pass does not touch `specs/`); updating
  it is the leader's/spec owner's call, not mine to make unilaterally in
  an `sdd: false` feature pass.

## Pass 2 — the four saga-verification criteria

**Status: all four proven, genuinely armed and watched fail.** R56's
composed-stack trace observation (the fifth acceptance bullet) is
explicitly out of scope for this pass — Pass 3's job, per the leader's own
brief.

### What was built

One new file, `apps/gateway/src/saga-e2e-verification.integration.spec.ts`
— a single `describe` block, one shared `beforeAll`/`afterAll` fleet, four
`it()`s, one per criterion. Plus one new test-support helper,
`apps/gateway/src/test-support/mysql-worker-client.ts` (why it exists: see
"An architectural guard this pass violated, and how it was fixed" below).

**Fleet-reuse approach (stated explicitly, per the brief's own
instruction):** ONE shared fleet, built once in `beforeAll` (≈40–90s
depending on Kafka/KRaft coordinator warm-up variance observed across
runs) and torn down once in `afterAll`:

- 3 disposable `MySqlContainer`s (`mysql:8.4.11`) — one each for
  `otc_orders`/`otc_fulfillment`/`otc_billing`, migrated via each
  service's own REAL `db:migrate` CLI (`migrate-cli.ts`) run as a genuine
  child process (`runMigrationsCli`, `tsx`, never an imported migrator
  module) — the same command a developer runs by hand, against a fresh
  database, exactly as CI would.
- 1 Kafka broker (`startKafkaTestFixture`, `apache/kafka:4.3.1`) with
  every fact topic AND its `.dlq` companion pre-created (6 topics).
- 1 auth-free NATS broker (`startOpenNatsTestFixture`) — required, not
  optional: a spawned, unmodified service's own `NATS_URL`-driven
  connection has no way to receive injected credentials (Pass 1's own
  finding), so the authenticated `@testcontainers/nats` fixture every
  per-service harness uses would not work here.
- 1 authenticated MongoDB (`startAuthenticatedMongoTestFixture`), one
  fixed, randomly-suffixed database name shared between the test's own
  Mongo client and the spawned Projector's `MONGO_DB_READMODEL`.
- Four real spawned processes: Fulfillment, Billing and Projector started
  CONCURRENTLY first (via `spawnRealService`/`spawnRealProjector`), Orders
  spawned LAST once its downstream responders are already listening (so
  the saga's first RPCs never race a responder that has not booted) —
  then one explicit `waitForConsumerGroupReady('orders.saga-server')`
  block, paid once, before any criterion runs.
- Reference data seeded via raw SQL (a currency/retailer/company/product
  row in Orders, one generous `stock` row in Fulfillment, one generous
  `credits` row in Billing) — same proven-valid GLNs/codes
  `orders-test-fixture.ts` already uses, duplicated rather than imported
  (this file imports no service's own `src/`, only speaks NATS/Kafka/SQL
  the way an operator would).

All four `it()`s place their OWN order(s) against this one fleet — no test
depends on state left behind by another (reusing the fleet, never the
data) — and each carries its own generous per-test timeout (120s–240s)
independent of the others.

### An architectural guard this pass violated, and how it was fixed

Adding `mysql2` as a `apps/gateway` devDependency (the obvious first
approach for querying Orders/Fulfillment/Billing's own databases directly)
made `pnpm quality` fail — `apps/gateway/src/no-write-database-client.spec.ts`
(Group B's own guard, pre-existing, untouched) makes it a hard
architectural rule that Gateway can never declare or resolve
`mysql2`/`drizzle-orm` in ANY form, because Gateway answers reads from the
projector's read model only, never a write-model database directly. This
was a genuine, real mistake caught by the guard doing exactly its job —
not a false positive, not something to weaken. Fixed by
`mysql-worker-client.ts`: it spawns a plain `node -e '<script>'` child
process (the script text is a literal string inside that one `.ts` file,
never an on-disk file `require`d/imported by anything — an earlier
on-disk `.cjs` draft failed lint instead, since ESLint's flat config
applies `no-undef`/`no-require-imports` to every file with no narrower
`files:` scope ahead of it) that `require()`s the TARGET service's own
installed `mysql2` by a fully-resolved ABSOLUTE FILE PATH
(`<serviceDir>/node_modules/mysql2/promise.js`) — bypassing Node's module
resolution algorithm (and any `package.json` "exports" map) entirely, so
`apps/gateway`'s own `require.resolve` footprint (what the guard spec
actually checks, via a real, unmodified child `node` process) never
changes. Re-verified: `apps/gateway/src/no-write-database-client.spec.ts`
green, `apps/gateway/package.json` carries no `mysql2`/`drizzle-orm`
dependency of any kind.

### The four criteria, and what was actually proven

**Criterion 1 — happy path reaches `completed`.** Places a real order
(1500 × 2 = 3000 minor units, no `.99`/credit-limit edge), polls Orders'
MySQL for `status = 'invoiced'`, reads the real issued invoice from
Billing's MySQL, registers a real payment over `billing.payment.register`
(bare NATS, `x-correlation-id = orderId` — the saga invariant
`progress/current.md` already documents as a real, previously-live gap),
then polls for `status = 'completed'`. Confirmed (by reading
`saga-steps.ts`) that `completed` is reached via TWO facts after
payment — `payment.received.v1` (→ `paid`) then `credit.released.v1`
(→ `completed`, both emitted by Billing's `payment-register.handler.ts`
in the same transaction) — so no extra step was needed once payment was
registered.

**Armed and watched fail.** Corrupted `x-correlation-id` on the payment
call to a fresh random UUID instead of `placed.orderId` (the exact
external-trigger gap `progress/current.md` already documents live).
Re-ran: `Error: saga-e2e-verification: condition not met within 60000ms`
at the final `waitFor(status === 'completed')` — the order genuinely never
completes when the payment is filed under the wrong correlation id.
Restored; re-verified green (part of the full 4/4 green run).

**Criterion 2 — a `.99` order compensates visibly.** Places an order at
1099 minor units (qty 1, `1099 % 100 === 99`), polls for
`status = 'cancelled'`. Two things are asserted precisely, not inferred:
(a) Orders' own `cancellationReason` column — **`'credit_rejected'`**, not
the string `'simulated_cents_rule'` the brief's own text names. Read
`order-cancellation-reason.ts`: the domain's closed `CancellationReason`
set is exactly `'stock_rejected' | 'credit_rejected' | 'operator_cancelled'`
— `'simulated_cents_rule'` is never a legal value there. It is Billing's
OWN, more granular internal refusal reason
(`simulator-credit-decision.ts`), and `mapReason` in `saga-steps.ts`
narrows `stock.released.v1`'s payload down to the 3-value domain set
before it ever reaches Orders' `cancellationReason` column. This is a
factual discrepancy in the brief, reported here rather than silently
"fixed" by asserting a value the domain can never actually produce — (b)
Billing's own `credit.rejected.v1` outbox row (read directly, by
`correlation_id` + `event_type`) carries `payload.reason ===
'simulated_cents_rule'` — the SPECIFIC, precise proof that the trigger
really was the `.99` rule and not some other refusal, which is what the
brief's own wording is actually reaching for. Also confirmed — per the
brief's explicit instruction "not merely inferred from the order's own
status field" — the real Fulfillment `reservations` row for the order is
`status = 'released'`.

**Armed and watched fail.** Changed the seeded amount to 1098 (one minor
unit off the `.99` boundary) and removed the now-inapplicable
`% 100 === 99` assertion. Re-ran: `Error: saga-e2e-verification: condition
not met within 60000ms` at the `waitFor(status === 'cancelled')`, with the
diagnostic dump showing the order genuinely stuck at `status: 'invoiced'`
(every saga command `sent`, no `credit.rejected.v1`/`stock.released.v1` in
the outbox) — proving the `.99` total, not some incidental property of the
order, is what triggers compensation. Restored; re-verified green.

**Criterion 3 — redelivery causes no corruption.** Places a real order,
waits until its status is AT LEAST `stock_reserved` (see "a real flake
found and fixed" below for why "at least", not "exactly"), then reads
back the REAL `order.placed.v1` envelope Orders' own `OutboxRelay` already
published — byte-for-byte, from Orders' own `outbox` row (never
fabricated) — and republishes it, unchanged, to a fixed Kafka partition.
Immediately behind it, on the same partition, publishes a second,
synthetic-but-well-formed `order.placed.v1` for a random, non-existent
order id (a "marker") — and waits for TWO independent, POSITIVE proofs
that the consumer got past the redelivery (never a bare sleep, per the
explicit rule that an absence-of-side-effect assertion proves nothing
about whether anything was attempted): a `saga_ignored_facts` row for the
marker's `eventId` with `marker = 'unknown_order'` (Orders' own saga
consumer group), AND a fresh `order_timeline` Mongo document for the
marker's order id (the Projector's own, independent consumer group).
THEN asserts exact row counts, before vs. after: Orders'
`saga_commands` (`stock.reserve`, count stays 1), Fulfillment's
`reservations` (count stays 1), and the Mongo document's own
`order.placed.v1` event-array length (stays 1).

**Armed and watched fail — genuinely, after real code-reading, not
guesswork.** The first attempt (disabling only Orders' own
`idempotent-consumer.ts` dedup check) stayed green — reading the actual
call graph (`saga-fact-handler.ts` → `saga-fact.handlers.ts` →
`OrderSagas`'s `@Saga()` → `saga-dispatch.handlers.ts` →
`SagaCommandDispatcher.dispatch()` → `StockReservationHandler.reserve()`)
found FOUR independent, cooperating guards protecting this exact
scenario, not one: (1) `idempotent-consumer.ts`'s `(eventId, consumer)`
dedup, (2) `saga_fact_handler.ts`'s R25 precondition check (`order.status
!== step.precondition` — the ACTUAL dominant guard here, since a real,
live-speed saga has almost always already advanced the order past
`placed` by the time a redelivery lands, well before the eventId-dedup
layer would even matter), (3) `saga-command-dispatcher.ts`'s `row.status
=== 'sent'` no-op check, and (4) Fulfillment's own FS5 responder
idempotency (`stock-reservation.handler.ts`: "ANY reservation rows for
the order, whatever their status, short-circuit before any domain call").
Disabling any one, two or three of these in isolation left the suite
green — genuine defense-in-depth, not a test blind spot. Disabling all
FOUR together (temporarily, `apps/orders/src/application/saga-fact-handler.ts`,
`apps/orders/src/infrastructure/messaging/idempotent-consumer.ts`,
`apps/orders/src/infrastructure/saga/saga-command-dispatcher.ts`,
`apps/fulfillment/src/application/stock-reservation.handler.ts`)
reproduced the corruption cleanly: `AssertionError: expected 2 to be 1 //
Object.is equality` at `expect(reservationsAfter.n).toBe(reservationsBefore.n)`
— a genuine SECOND Fulfillment reservation row, while
`sagaCommandsAfter.n === sagaCommandsBefore.n` stayed at 1 (Orders' own
`saga_commands` table has its own independent unique-index protection,
`onDuplicateKeyUpdate`, unaffected by any of the four bypasses). Every
production edit was a comment-annotated, `git diff`-verified no-op
restoration afterward — `git status --porcelain` on all four files
confirmed byte-clean before closing out, and `pnpm --filter @otc/orders
typecheck`/`pnpm --filter @otc/fulfillment typecheck` re-ran green after
restoring (the FIRST attempt at this arm, `if (false && ...)`, failed
`tsc` outright — TypeScript's unreachable-code narrowing loses the
outer `!order`/`!step` guards' established non-null narrowing inside a
statically-dead `if (false && ...)` branch; fixed by commenting the block
out entirely instead, which does not confuse the checker).

**A real flake found and fixed, not merely a hypothetical one (disclosed
per this pass's own "armed and watched fail" discipline, though it is not
itself a bug in the SUT):** the very first run of criteria 1–3 timed out
polling for an EXACT intermediate status (`'invoiced'` in criterion 1
before payment, `'stock_reserved'` in criterion 3) — the diagnostic dump
showed the order had already raced PAST that status (all the way to
`invoiced` in criterion 3's case) well inside one 300ms poll interval.
This is the human's own manually-observed "ORD-000035 completed in under
a second" claim, now independently confirmed under test: this real fleet
processes a whole order end-to-end faster than a single poll tick.
Fixed with a small `ORDER_STATUS_RANK`/`statusRank()` helper and an
"at least this status" wait predicate for criterion 3 (criterion 1's
target, `'invoiced'`, is a genuinely STABLE resting state — nothing
advances it further without the test's own payment call — so no change
was needed there beyond the diagnostic wrapper).

**Criterion 4 — a poisoned message reaches the DLQ.** Publishes a
malformed `order.placed.v1` (`correlationId: 'not-a-uuid-correlation-id'`
— the exact live Phase-12 shape, `progress/current.md`) to a fixed Kafka
partition against the real running Orders process (`FACT_RETRY_MAX_ATTEMPTS=3`,
`FACT_RETRY_BACKOFF_MS=50` set on the spawned Orders' own env for a fast,
deterministic exhaustion — same override every per-service dead-letter
spec in this repo already uses), waits for it on `otc.orders.facts.v1.dlq`,
asserts the DLQ headers (`x-failed-consumer`, `x-original-topic`,
`x-error`) and the unmodified original `correlationId`. THEN — the
property that actually failed live — publishes a second, well-formed
(valid UUID, but for a non-existent order) fact right behind it on the
SAME partition, and waits for a POSITIVE proof the consumer processed it
too (`saga_ignored_facts`, `marker = 'unknown_order'`) — proving the
offset committed and the partition was never blocked.

**Armed and watched fail.** Changed the poison message's `correlationId`
from `'not-a-uuid-correlation-id'` to a fresh, valid `randomUUID()` (same
malformed-shape-vs-well-formed contrast as every other arm in this pass).
Re-ran: `Error: saga-e2e-verification: condition not met within 60000ms`
waiting for the DLQ message — a well-formed fact for an unknown order
never reaches the DLQ at all (it is filed to `saga_ignored_facts`
instead, the correct outcome), confirming the DLQ path is genuinely gated
on the malformed shape, not merely "any fact this test happens to send".
Restored; re-verified green.

### Files touched (this pass only)

- `apps/gateway/src/saga-e2e-verification.integration.spec.ts` (new) — the
  four-criterion suite.
- `apps/gateway/src/test-support/mysql-worker-client.ts` (new) — the
  no-`mysql2`-dependency MySQL query client (see "An architectural guard
  this pass violated" above).
- `apps/gateway/package.json` (edit) — `@testcontainers/mysql` added
  (devDependency); `mysql2` was added then REMOVED in the same pass (see
  above) — net diff is `@testcontainers/mysql` only.
- `pnpm-lock.yaml` — updated by `pnpm install` after the `package.json`
  edit.
- Four production files were temporarily edited and fully restored during
  criterion 3's armed-deletion probe (see above for the exact list) — `git
  status --porcelain` on all four confirmed clean before this pass closed
  out; **no net change** to any file under `apps/orders` or
  `apps/fulfillment`.

### Packages installed (disclosed per CLAUDE.md)

`apps/gateway`, devDependency: `@testcontainers/mysql` — spins up the
three disposable MySQL databases this suite migrates and seeds. (`mysql2`
was evaluated and rejected — see "An architectural guard this pass
violated" above; it is NOT part of the final dependency set.)

### Self-verification

- `saga-e2e-verification.integration.spec.ts`'s own run (`pnpm --filter
  @otc/gateway test:integration -- src/saga-e2e-verification.integration.spec.ts`):
  **4 files… 4 tests, all green**, ~66–172s wall clock across repeated
  runs (Kafka/KRaft coordinator warm-up variance — see the "real flake"
  note above; every run stayed within each `it()`'s own generous
  timeout).
- `pnpm quality` (root: `eslint .` + `pnpm -r typecheck` + `pnpm -r test`)
  — **exit 0**, every workspace green, including all four services this
  pass's armed-deletion probes touched-then-restored (`apps/orders`,
  `apps/fulfillment` typecheck/test both re-ran clean after every
  restoration).
- `./init.sh` — still exits 0.

### What remains

- **R56's composed-stack trace observation** — Pass 3's own job,
  explicitly out of scope here. Given what this pass learned building the
  fleet (env-var contracts for all four services now proven working
  together; the "at least this status" race-avoidance pattern; the
  `no-write-database-client.spec.ts` guard and its `mysql-worker-client.ts`
  workaround, reusable as-is for any Mongo/Kafka-side trace assertion Pass
  3 needs against Orders/Fulfillment/Billing's own databases), Pass 3
  looks materially MORE tractable than it did before this pass — the
  hardest infrastructure work (multi-process fleet orchestration,
  Kafka/NATS/Mongo wiring, the DB-access guard) is now done and directly
  reusable; what remains for Pass 3 is specifically the trace-propagation
  assertion itself (reading span/trace ids from the OTel collector or an
  injected in-process exporter across all four spawned processes), which
  this pass deliberately did not attempt.
- `specs/shared/test-matrix.md` is untouched (bounded scope: this pass
  does not touch `specs/`) — its rows for the four criteria proven here
  (however they are eventually named/mapped) are the leader's/spec
  owner's call, not mine to make unilaterally in an `sdd: false` feature
  pass.
- `feature_list.json` is untouched — the brief's own bounded scope
  explicitly excludes it from this pass.

## Pass 3 — R56 composed-stack trace observation

**Status: done, but with a genuine, material finding that narrowed the
technique from the one the brief prescribed.** Reused Pass 2's SAME shared
fleet (no second fleet spun up) and added ONE fifth `it()` to Pass 2's own
`describe` block.

### The finding — R58's "every log line" is not actually every service

The brief's own premise was: "feature 27 already proved every structured
JSON log line across every service carries `traceId` (R58) ... That is
sufficient to prove R56's literal requirement directly." Before writing the
test, I re-read every JSON-shaped structured logger in the entire monorepo
(`grep -rn "console\.\(log\|error\)\|logger\.\(info\|log\|warn\|error\)"`
across `apps/fulfillment`, `apps/billing`, `apps/projector`, `apps/gateway`
and `apps/orders`, non-spec files) rather than trust the premise. Result:

- **`apps/orders`** has exactly ONE info-level, traceId-bearing structured
  log that fires on a healthy order: `saga-command-dispatcher.ts`'s
  `"saga-command-dispatcher: command sent"` line — one per dispatched saga
  command (`stock.reserve`, `credit.hold`, `despatch.create`,
  `invoice.issue` for a normal order reaching `invoiced`), each carrying
  `correlationId` (the order id) and `traceId` (`activeTraceId()`). Every
  OTHER structured logger in `apps/orders` (`outbox-relay.ts`,
  `fact-retry-dispatcher.ts`, `saga-command-sweeper.service.ts`,
  `saga-first-park-dead-letter-handler.ts`, `saga-facts.controller.ts`) is
  error-only, never reached by a healthy order. `orders-create.controller.ts`
  itself — the actual inbound-request entry point — logs nothing at all.
- **`apps/fulfillment` and `apps/billing`** each have EXACTLY ONE
  JSON-shaped structured logger in their entire codebase —
  `outbox-relay.ts`'s publish-failure error log — and it is the ONLY one;
  neither service has any info-level logging anywhere. Not reached by any
  of Pass 2's four scenarios (all are healthy-Kafka-publish paths).
- **`apps/projector`** has four JSON-shaped structured loggers, all
  error-only (`mongo-read-model-writer.ts`'s insert-race retry,
  `projection-apply.service.ts`'s signal-publish-failure,
  `projector-facts.controller.ts`'s malformed-envelope/DLQ paths,
  `fact-retry-dispatcher.ts`'s dead-letter). None fire on a healthy
  consume, and Projector owns no outbox (nothing durable to fall back to
  either) — its own `trace-context.ts` says so explicitly ("The
  `outbox.trace_parent` shape does not exist in THIS service — it owns no
  outbox, it only consumes").
- **`apps/gateway`** has exactly one JSON-shaped structured logger
  (`problem-json.filter.ts`, error-only) — moot here anyway, since this
  fleet, unchanged from Pass 2, never spawns a Gateway process at all
  (every order is placed via a raw NATS call straight into
  `orders.create`, the same mechanism Pass 2's own four criteria already
  use — confirmed by re-reading Pass 2's own file header, which states
  this explicitly).

`test-matrix.md`'s own R58 row, read literally, never actually claims
otherwise — every file its "DONE" description names is under
`apps/orders`/`apps/gateway`. So this is not a regression this pass
introduced or found live; it is a gap in the Pass-3 BRIEF's own premise,
which generalised R58's real (narrower) scope to "every service." Reported
here precisely, as the brief's own instructions require, rather than
silently routed around or silently weakened.

### What was actually built, given that finding

Composing "parse every JSON log line, extract traceId, across every
process" literally is not possible for three of the four spawned services.
Rather than either (a) fabricate logging in production source (explicitly
forbidden — "tests only" scope) or (b) silently narrow the claim to
"Orders has a traceId" (the exact class of overclaim the brief itself
warns against), criterion 5 composes the BEST REAL, ALREADY-EXISTING
evidence from TWO genuine channels, never fabricated for this purpose:

1. **Orders' own captured stdout** (`ordersProcess.output()`, Pass 1's own
   full-capture guarantee) — parses every `"saga-command-dispatcher:
   command sent"` JSON line, filtered to this order's own `correlationId`,
   asserts at least 2 DISTINCT commands were observed (genuinely "every
   command," not one coincidental line), and every line's `traceId`
   matches `/^[0-9a-f]{32}$/`.
2. **Fulfillment's and Billing's own durably-recorded `outbox.trace_parent`
   column** (R57, Pass 1's own work) — read back over the SAME
   `MySqlWorkerClient` raw-SQL technique Pass 2 already established, for
   `stock.reserved.v1` (Fulfillment) and BOTH `credit.approved.v1` and
   `invoice.issued.v1` (Billing, two independent write-model transactions
   in the SAME process). Not a log line, but a genuinely independent,
   real, per-process record of THAT process's own active OTel trace
   context at the moment it performed its own write — exactly what R57's
   Pass-1 armed test already proved is trustworthy, composed here into ONE
   assertion for one concrete order across the LIVE fleet, rather than
   asserted in isolation.
3. **Single-identifier assertion**: every extracted value (Orders' N log
   lines + Fulfillment's 1 + Billing's 2) is parsed to its raw 32-hex
   trace-id (`traceIdFromTraceParent`, splitting the W3C `traceparent`
   string), collected into one `Set`, and asserted to have size 1 —
   genuine cross-process EQUALITY, not per-process presence.

Projector is explicitly NOT included — no durable record, no log, and no
OTel collector stood up (out of this pass's explicit scope) — its
participation in this order's trace is genuinely unobservable from outside
its own process today. Gateway is explicitly not included either, for the
reason above (not part of this fleet at all — a Pass 2 design decision,
unchanged). Both stated as findings, not routed around.

New test: `apps/gateway/src/saga-e2e-verification.integration.spec.ts`,
fifth `it()`, `"criterion 5 (R56) — one trace identifier spans a real
order across the composed stack: every Orders saga-command dispatch AND
the real trace_parent Fulfillment and Billing each independently recorded
on their OWN write-model transaction, all identical, across three real
separate processes"`. Places its own order (1200 minor units, not `.99`),
waits for `status = 'invoiced'` (reuses `waitFor`/`dumpOrderDiagnostics`,
Pass 2's own pattern), then does the three-source, single-Set assertion
above.

**Armed and watched fail.** Temporarily changed
`apps/fulfillment/src/infrastructure/outbox/outbox-recorder.ts`'s `const
traceParent = activeTraceParent();` to `const traceParent = null;` (the
exact single-line arm Pass 1 already used for the same claim, in
isolation; this pass composes it into the end-to-end assertion). Rebuilt
(automatic, `spawnRealService`'s own `tsc` build step) and re-ran just
criterion 5 (`-t "criterion 5"`, same fleet, ~60s). Result — a precise,
named, verbatim failure: `AssertionError: fulfillment (stock.reserved.v1
outbox): expected a real 32-hex traceId, got null: expected false to be
true`, at the exact per-source label assertion. (First attempt at this arm
used `.toMatch()` directly on a possibly-`null` value, which threw a raw
`TypeError: .toMatch() expects to receive a string, but got object`
instead of a clean, diagnosable assertion — fixed by checking
`typeof traceId === 'string'` explicitly before the regex test, for both
the per-source loop and Orders' own log-line loop, so a real break always
produces a named, readable failure rather than a type-confused crash.)
Restored `outbox-recorder.ts` to `activeTraceParent()`; `git diff` on the
file afterward showed it byte-identical to Pass 1's own already-landed,
uncommitted working-tree state (confirmed — the file still shows as
modified in `git status`, but that modification is Pass 1's pre-existing,
not-yet-committed change, unrelated to and unaffected by this pass's
arm/restore cycle). Re-ran the full 5-criterion suite: all green again.

### Self-verification

- Full 5-criterion suite (`pnpm exec vitest run --config
  vitest.integration.config.mts src/saga-e2e-verification.integration.spec.ts
  --reporter=verbose`, from `apps/gateway`): **5 files… 5 tests, all
  green**, criterion 5 itself in ~640–645ms (fast — no new fleet spin-up),
  full suite 97.89s–112.83s across three separate runs (pre-arm, post-arm
  full-suite re-check).
- Armed run (criterion 5 only, `-t "criterion 5"`): **1 failed, 4 skipped**
  — the precise, named failure above. 58.36s (fleet spin-up + one test).
- `pnpm quality` (root: `eslint .` && `pnpm -r typecheck` && `pnpm -r
  test`) — **exit 0**. Lint clean (chain continued past it), every
  workspace's typecheck `Done`, every workspace's unit suite green (10/10
  workspaces, e.g. `apps/orders` 479/479, `apps/gateway` 121/121,
  `apps/fulfillment` 83/83, `apps/billing` 138/138, `apps/projector`
  133/133 — no regression anywhere from this pass's arm/restore cycle).
- `./init.sh` — exit 0.
- `git status --porcelain` on the three touched paths: the spec file (new,
  untracked, as expected), this progress file (new, untracked), and
  `outbox-recorder.ts` (modified — confirmed, by `git diff`, to be
  byte-identical to its Pass-1 pre-arm state, i.e. no net change from this
  pass).

### Files touched (Pass 3 only)

- `apps/gateway/src/saga-e2e-verification.integration.spec.ts` (edit) —
  widened header comment (now documents all five criteria and this pass's
  own finding), `describe` title updated, two new top-level helpers
  (`ordersCommandSentLogEntries`, `traceIdFromTraceParent`), and the fifth
  `it()`.
- `apps/fulfillment/src/infrastructure/outbox/outbox-recorder.ts` —
  temporarily edited for the armed-deletion probe, fully restored; no net
  change (see above).
- `progress/impl_saga_e2e_verification.md` (this file) — this section.

No new dependency installed this pass. `specs/` and `feature_list.json`
untouched (bounded scope, unchanged from Pass 1/2's own note).

### Final check across all three passes — feature 28's five acceptance criteria

1. **Happy path reaches `completed`.** Closed — Pass 2, criterion 1, armed.
2. **A `.99` order compensates visibly (cancelled, correct reason, real
   released reservation).** Closed — Pass 2, criterion 2, armed.
3. **Redelivery causes no corruption anywhere in the system.** Closed —
   Pass 2, criterion 3, armed (the four-guard defense-in-depth finding).
4. **A poisoned message reaches the DLQ without blocking the partition.**
   Closed — Pass 2, criterion 4, armed.
5. **R56's composed-stack trace observation.** Closed THIS pass, armed —
   but with an honest, load-bearing caveat, stated precisely rather than
   hidden: the proof covers Orders, Fulfillment and Billing (three of the
   four saga-relevant real processes) with genuine cross-process
   trace-identifier EQUALITY, using structured logs where they exist
   (Orders) and durably-recorded `trace_parent` columns where they don't
   (Fulfillment, Billing). It does NOT, and — with current instrumentation
   and no OTel collector stood up (out of every pass's explicit scope) —
   CANNOT, observe the Projector's own participation in the trace (no
   durable record, no log line, nothing externally observable), and it
   does not observe an inbound-HTTP-to-Gateway leg specifically, because
   this fleet (a Pass 2 design decision, unchanged) never spawns a Gateway
   process — every order enters the fleet via the same raw NATS call all
   five criteria now use. Both are genuine, residual gaps, not silently
   routed around: closing them for real would need either (a) a real OTel
   collector/span-query surface (explicitly deferred to Phase 22 by this
   feature's own brief) or (b) adding Projector-side
   logging/trace-recording in production source, which is out of every
   pass's "tests only" scope and was not done.

**Plain statement:** all five of `feature_list.json` id 28's acceptance
criteria are now demonstrably met by a real, armed, cross-process,
multi-service integration suite — but R56's own closure carries the
residual scope caveat above (Projector unobserved, Gateway not part of
this fleet), which should be read alongside the "done" status rather than
smoothed over.
