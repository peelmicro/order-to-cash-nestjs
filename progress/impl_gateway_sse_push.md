# `gateway_sse_push` (id 26, phase 13) — implementation record

## What this feature actually needed

Feature 25 (`gateway_rest_auth`) built essentially the entire SSE surface as its own "group D": `StreamHub`, `ReplayBuffer`, `CursorGenerator`, `NatsStreamSignalAdapter`, `StreamController`, and `stream.integration.spec.ts` (5 tests) plus `stream-hub.spec.ts`/`replay-buffer.spec.ts`/`cursor.spec.ts` at unit level. This feature's job was to close the gap between that surface and the two acceptance criteria as literally worded, not to rebuild anything.

## What was already discharged, verified by reading and re-running

- **F7 (ping heartbeat emission) — already closed**, by feature 25's fix pass. `stream.integration.spec.ts`'s `describe('Gateway SSE stream — ping heartbeat (F7, review finding)')` boots a dedicated app with `GATEWAY_SSE_PING_INTERVAL_MS=200`, asserts ≥2 `ping` frames each with a parseable `at`. Re-ran it: green.
- **"resumes what was missed"** — `stream.integration.spec.ts`'s existing `'R55 reconnection — a known Last-Event-ID replays every frame missed since, resumed:true'` proves the replay is non-empty and carries the right content. It does **not** prove the boundary is exclusive (see below) — that is the actual gap acceptance criterion 1 names.
- **F14** (EventSource cannot set `Authorization`) — correctly left open, out of scope per this task's brief; still recorded as owed below.

## What was added

### 1. Acceptance 1, "client reconnect resumes without duplicates"

**Ruling on what this can mean.** `openapi.yaml`'s own reconnection section states delivery is at-least-once and that clients deduplicate on `data.eventId` — so "without duplicates" cannot be a transport-level exactly-once guarantee; nothing in this system offers that, and testing for it would be testing something the contract explicitly disclaims. The reading that *is* a genuine, transport-level, testable guarantee is the replay boundary: resuming from cursor `C` must return **strictly the frames after `C`**, never `C`'s own frame again. "Resumes after", never "resumes at-or-before". `ReplayBuffer.replayAfter` already implements this (`slice(index + 1)`), and `replay-buffer.spec.ts` already unit-tests it — but nothing had proven it holds over the real HTTP/SSE wire, across an actual disconnect/reconnect, with the actual `Last-Event-ID` header round-trip. That is the gap I closed.

**Test added:** `apps/gateway/src/stream.integration.spec.ts` › *`R55 "without duplicates" — reconnecting with the cursor of an already-received frame never redelivers that frame`*. It opens a connection, receives one `order.updated` frame, records both its cursor and its `eventId`, disconnects, lets a second fact land while disconnected, reconnects with `Last-Event-ID` set to the first frame's cursor, and asserts: the reconnected stream never repeats that cursor, never repeats that `eventId`, and replays exactly the one frame that arrived after it.

**Armed by deletion.** I flipped `apps/gateway/src/domain/sse/replay-buffer.ts`'s `slice(index + 1)` to `slice(index)` (re-including the cursor's own frame — the exact off-by-one this test exists to catch) and reran:

```
FAIL  src/stream.integration.spec.ts > Gateway SSE stream — Group D (R55) >
  R55 "without duplicates" — reconnecting with the cursor of an already-received frame never redelivers that frame
AssertionError: expected true to be false
- Expected: false
+ Received: true
 ❯ src/stream.integration.spec.ts:172:70
```

The pre-existing unit spec `replay-buffer.spec.ts` failed on the same mutation too (3 of 7 cases, e.g. *"returns everything after a known cursor, resumed:true"* expected `missed: ['b','c']`, got `['a','b','c']`) — confirming the boundary was already guarded at unit level; what was missing was proof it holds across the real HTTP wire, which the new integration test now supplies. Reverted the mutation; both files re-ran green (`replay-buffer.spec.ts` 7/7, `stream.integration.spec.ts` 6/6).

### 2. Acceptance 2, "heartbeat keeps the connection alive"

**Judgment: the stronger claim is not testable in this harness, and I did not attempt it.** F7's test (already in the suite before this feature) proves a `ping` frame is *emitted* on the configured interval — a fact about the server's own behaviour. "Keeps the connection alive" is a claim about what an intermediary (an idle-timeout proxy, a load balancer, a browser's own TCP stack) would otherwise have done *absent* the ping — that requires an actual idle-timing intermediary in the test, which this harness has none of (the SSE client here is a raw `http.request` straight to the app's own listener; there is no proxy to starve). Manufacturing one (e.g. a bespoke reverse proxy with a sub-ping-interval idle timeout, wired into a new test just to prove the ping prevents ITS specific timeout) would be testing a fixture I invented, not the production topology, and risks exactly the kind of hollow guard CLAUDE.md warns against here. I recorded this rather than testing something weaker and calling it done. What stands as genuine evidence for this criterion is F7's existing test: the mechanism keeping intermediaries from timing out a genuinely idle connection exists and fires on schedule; a real end-to-end idle-timeout proof is out of this harness's reach and I did not fabricate one.

### 3. The projector→SSE seam (review finding N4, feature 24's review)

**Achievable, and I built it.** Every existing stream test (`stream.integration.spec.ts`) publishes directly onto `readmodel.order.updated.*`/`readmodel.timeline.appended.*` — the SAME subjects the real projector publishes on — which proves the gateway's half of the wire but never proves the projector actually produces that wire from a real fact.

New spec: `apps/gateway/src/stream-projector-e2e.integration.spec.ts`. It boots, all real via Testcontainers:
- a real Kafka broker (`apache/kafka:4.3.1`, same image `docker-compose.infra.yml` and `apps/projector`'s own fixtures use — copied into `apps/gateway/src/test-support/kafka-test-fixture.ts`, the same "COPY OF" pattern already used across `apps/orders`/`apps/billing`/`apps/fulfillment`);
- a real, **unmodified `apps/projector` service, spawned as a genuine OS child process** (`apps/gateway/src/test-support/spawn-real-projector.ts`) — not an imported `AppModule`. Gateway carries none of `@nestjs/microservices`/`kafkajs`-as-a-dependency/`apps/projector`'s own dependency graph, and no service in this repo imports another service's TypeScript source; the child process runs `apps/projector`'s own local `tsx` against its own unmodified `src/main.ts`, driven entirely by the same env vars its `mongo.config.ts`/`kafka.config.ts`/`nats.config.ts` already read. No file under `apps/projector` was read for anything but understanding, none was patched;
- a real MongoDB (the gateway's existing authenticated fixture, shared verbatim with the spawned projector via matching env var defaults);
- a real NATS broker — but **not** `@testcontainers/nats` (every real-`AppModule` NATS test in this repo, including gateway's own `gateway-app-test-harness.ts`, documents in writing that it must override the `NATS_CONNECTION` provider directly rather than go through a bare `NATS_URL`, because that package forces `--user test --pass test` with no opt-out, and `nats@2.29.3` never extracts credentials from a `nats://user:pass@host` URL — I verified this by reading `nats-base-client/servers.js`: `ServerImpl` carries no `username`/`password` field at all). A spawned child process authenticates purely from `NATS_URL`, so it cannot take that shortcut. `apps/gateway/src/test-support/open-nats-test-fixture.ts` stands up plain `nats:2.14.5-alpine` with no auth flags at all — which is also the more faithful choice: `docker-compose.infra.yml`'s real `nats` service (`command: ["-p", "4222", "-m", "8222"]`) runs auth-free too, matching CLAUDE.md's "NATS runs core-only".

The test: subscribes an SSE client first (subscribe-before-produce, no sleep), publishes a real `order.placed.v1` envelope onto `otc.orders.facts.v1` via `kafkajs`, and asserts the real projector's consumption, projection and NATS publication surface at the connected client as `order.updated` (`status: 'placed'`, matching `eventId`) and `timeline.appended` (`eventType: 'order.placed.v1'`). Ran it **twice** to check for flakiness from the spawned process / real broker path — both green, ~20s each.

**What this test does NOT prove**, stated honestly: the `orders → Kafka` leg (the outbox relay actually publishing the fact in the first place) is out of this feature's scope and is proven elsewhere (`outbox_and_idempotency`, `orders_acceptance`); this spec picks the chain up at "a fact exists on the topic" — the same seam `apps/projector`'s own integration specs already start from. N4's full "gateway → orders → Kafka → projector → NATS" walk in one run remains unproven by anyone; this closes the projector→NATS→gateway two-thirds of it, which is the half that is actually feature 26's to own.

**New devDependency:** `kafkajs` (catalog: `^2.2.4`) added to `apps/gateway/package.json`, needed to create the Kafka topic and produce the test fact — no other package changed.

## Files touched

- `apps/gateway/package.json` — `+kafkajs` devDependency
- `apps/gateway/src/stream.integration.spec.ts` — refactored to import shared SSE test-client helpers (below); added the "without duplicates" test
- `apps/gateway/src/test-support/sse-test-client.ts` — new; `SseFrame`/`parseSseFrames`/`openSseConnection`/`collectUntil`, extracted verbatim from `stream.integration.spec.ts` so the new E2E spec does not re-implement the SSE parser
- `apps/gateway/src/test-support/kafka-test-fixture.ts` — new; copy of `apps/projector`'s own fixture (comment explains why)
- `apps/gateway/src/test-support/open-nats-test-fixture.ts` — new; auth-free real-NATS Testcontainers fixture, `NatsTestFixture`-shaped
- `apps/gateway/src/test-support/spawn-real-projector.ts` — new; spawns the real projector as a child process, waits for its Kafka consumer group to be `Stable`
- `apps/gateway/src/stream-projector-e2e.integration.spec.ts` — new E2E spec (group E)
- `pnpm-lock.yaml` — regenerated for the new devDependency only (3-line diff)

Nothing under `apps/projector`, `apps/orders`, `apps/fulfillment`, `apps/billing`, `apps/notifications`, `packages/`, `specs/`, or `http/` was touched. `feature_list.json` was left untouched per this task's explicit bounded scope (status flip is the reviewer's).

## R → test

- **R55** (real-time push + projection-pending honesty) — gateway half already covered by feature 25's tests (unchanged here); this feature adds: `stream.integration.spec.ts` › *R55 "without duplicates" — …* (the replay-boundary exclusivity acceptance 1 actually needs) and `stream-projector-e2e.integration.spec.ts` › *a fact published on the real orders facts topic, consumed by the REAL projector, arrives at a connected SSE client as order.updated and timeline.appended* (the projector→NATS→gateway seam N4 named as owed).

## Owed / not done, and why

1. **F14** (EventSource cannot set `Authorization`) — explicitly out of scope per this task's brief; needs a spec amendment (`specs/shared/`) and a human gate decision, not this `sdd: false` feature's business.
2. **`specs/shared/test-matrix.md`'s R55 row** — not updated. The task's bounded scope explicitly forbids touching `specs/shared/` at all, so the row (which currently says "web half TODO (feature 26)" — itself a pre-existing misattribution, since the web half is feature 29's, not 26's) was left as-is. The leader/reviewer should route a `test_maintainer` pass to add this feature's two new tests to that row and correct the misattribution.
3. **Acceptance 2's stronger reading** ("keeps alive" as an idle-timeout-survival claim) — judged untestable in this harness without inventing an unrepresentative fixture; not attempted, recorded above.
4. **N4's full chain** (gateway → orders → Kafka → projector → NATS in one run) remains only two-thirds walked — the `orders → Kafka` leg is other features' province.

## Verification run log

- `pnpm --filter @otc/gateway run typecheck` — clean.
- `pnpm exec eslint` on every new/changed gateway file — clean, 0 output.
- `pnpm --filter @otc/gateway run test` (unit, no Docker) — 28 files / 114 tests, all green.
- `pnpm --filter @otc/gateway exec vitest run --config vitest.integration.config.mts` (`pnpm test:integration`, real Testcontainers) — **6 files / 34 tests, all green**, including the new duplicate-redelivery test and the new real-projector E2E test.
- `stream-projector-e2e.integration.spec.ts` run twice in isolation to rule out flakiness from the spawned-process path — both green (~20s each).
- Armed-and-reverted mutation: `replay-buffer.ts`'s `slice(index + 1)` → `slice(index)` — failed both the new integration test and 3/7 pre-existing unit cases with the verbatim messages quoted above; reverted; re-ran both files green.
- `pnpm quality` (root: `eslint .` + `pnpm -r typecheck` + `pnpm -r test`) — **green across all 10 workspace packages** (gateway: 28/114; orders: 33/415; billing: 26/130; fulfillment: 16/75; notifications: 18/71; projector: 13/117; seed: 8/119; shared-kernel: 10/68; contracts: 5/22; web typecheck only).
- `./init.sh` — exits 0.

## Surprises

- The `NATS_URL`-credential gap (nats.js never parses `user:pass@host` out of a server URL) was not something I expected going in — I initially assumed a plain `nats://test:test@host:port` would work for the spawned projector process and had to verify it wouldn't by reading `nats-base-client/servers.js` directly before committing to the auth-free-fixture design. Worth flagging for whoever eventually builds a genuinely cross-service Testcontainers harness (feature 28, `saga_e2e_verification`) — the same constraint will recur there for every real, spawned/subprocess service that needs to share a NATS broker with an in-process `TestingModule`.
- The `TimeoutNegativeWarning: -178...` Node warning that appears on every real-Kafka test run (this feature's and pre-existing ones alike, confirmed by re-running `apps/projector`'s own `timeline-projection.integration.spec.ts`) is inherited from the copied `kafka-test-fixture.ts` pattern itself, not something this feature introduced — noted, not chased, since it does not affect correctness or exit codes anywhere it appears.

## Review response (round 2) — F1, F3, F4, F5

`progress/review_gateway_sse_push.md` rejected on F1 (blocking); F3, F4, F5 minor. F2, F6, F7 are the leader's, untouched. `apps/projector` was built (via its own `tsc`) but not edited.

### F1 — the E2E now boots the projector on the production path

`spawn-real-projector.ts` no longer spawns `apps/projector`'s local `tsx` against `src/main.ts`. It now runs `tsc -p tsconfig.build.json` (the exact command `apps/projector`'s own `build` script runs, and the one `tsc-watch --onSuccess` re-runs on every recompile) via `spawnSync`, then spawns `node dist/main.js` — the identical artefact and runtime `pnpm dev:projector`/`pnpm start` use. The false "`pnpm dev:projector` minus `tsc-watch`" sentence is deleted; the header now states the real reason `tsx` is not used (`CLAUDE.md`'s DI-tokens rule: `tsx` is esbuild-based, does not implement `emitDecoratorMetadata`, so a bare-typed constructor parameter resolves to `undefined` silently under it), cites `apps/orders/src/di-metadata-divergence.spec.ts`, and states the build is rebuilt on every call rather than assuming a fresh `dist/`.

Evidence the E2E still passes on the new boot path: three independent green runs of `stream-projector-e2e.integration.spec.ts` alone, ~21-23s each (build ≈1.5s of that):
```
Test Files  1 passed (1)   Tests  1 passed (1)   Duration  21.46s
Test Files  1 passed (1)   Tests  1 passed (1)   Duration  21.97s
Test Files  1 passed (1)   Tests  1 passed (1)   Duration  22.24s
```
`ps aux` after all runs shows no orphaned `node`/`tsx`/projector process; `git status --porcelain apps/projector` stays empty (`dist/` is gitignored, rebuilt fresh each call, never committed).

### F3 — the "without duplicates" test now synchronises on terminal evidence, not elapsed time

The bare `await new Promise((resolve) => setTimeout(resolve, 100))` before the reconnect is replaced with a bounded retry loop: it opens a fresh reconnect with the same cursor, reads `stream.ready`'s own `resumed` flag, and only proceeds once `resumed === true` — retrying (with a short 50ms backoff, not a correctness mechanism) up to a 10s deadline, and `expect(resumed).toBe(true)` is now asserted explicitly, so the test can no longer pass silently via the live-push path.

Re-armed `replay-buffer.ts`'s `slice(index + 1)` → `slice(index)` with the fix in place:
- Unit (`replay-buffer.spec.ts`): same 3 of 7 died — *"returns everything after a known cursor"*, *"returns an empty missed list when the client is already caught up"*, *"R55/openapi 'the buffer is bounded'"*.
- Integration (`stream.integration.spec.ts`): **1 failed / 5 passed of 6** — only the new test died:
```
FAIL  src/stream.integration.spec.ts > Gateway SSE stream — Group D (R55) >
  R55 "without duplicates" — reconnecting with the cursor of an already-received frame never redelivers that frame
AssertionError: expected true to be false
 ❯ src/stream.integration.spec.ts:202:70
```
Verbatim-equivalent to the round-1 failure (message identical; line number shifted from 172→202 because the retry loop added lines above it), and it fired only *after* the retry loop had already confirmed `resumed: true` — proof the replay path, not the live-push path, was exercised. Reverted (`git diff` on `replay-buffer.ts` is empty); `replay-buffer.spec.ts` re-ran 7/7 green.

### F4 — `collectUntil` now preserves the buffer remainder across calls

Rewritten to keep exactly one `data` listener and one running `{buffer, collected, waiters}` state per `res` (keyed by a `WeakMap`, invisible to callers). Unconsumed bytes and previously-collected frames now persist across sequential `collectUntil` calls on the same connection; a predicate already true against earlier-collected frames resolves immediately without waiting on a new chunk. No caller changed. Confirmed via the full gateway unit suite (28/28 files, 114/114) and integration suite (6/6, 34/34) both green, since every existing `collectUntil` caller (Group D, Group E, the ping-heartbeat spec) exercises the new implementation.

### F5 — `afterAll` no longer lets a teardown failure compete with the real diagnostic

`stream-projector-e2e.integration.spec.ts`'s `afterAll` now runs `projector.stop`/`testApp.close`/`nats.teardown`/`kafka.teardown`/`mongo.teardown` as five independent steps in a loop, each wrapped in try/catch; a failing step is `console.error`-logged (naming the step) and the loop continues, so `afterAll` itself never re-throws and never manufactures a second failure report.

Armed directly: forced `testApp.close` to throw (`Error: F5-ARMED-TEARDOWN-FAILURE`) and the real `it` to throw (`Error: F5-ARMED-TEST-FAILURE`), then ran the spec. Result — exactly one failure report (`Failed Tests 1`, `[1/1]`), the real message intact and unburied:
```
FAIL  src/stream-projector-e2e.integration.spec.ts > SSE stream × the REAL projector — group E (R55 seam, review N4) >
  a fact published on the real orders facts topic, consumed by the REAL projector, arrives at a connected SSE client as order.updated and timeline.appended
Error: F5-ARMED-TEST-FAILURE
```
with the teardown failure logged separately and non-fatally:
```
stream-projector-e2e afterAll: "testApp.close" failed during teardown (continuing with the remaining steps; this is logged, not thrown, so it cannot bury a real test failure — see review finding F5): Error: F5-ARMED-TEARDOWN-FAILURE
```
and every other step (`nats.teardown` 300ms, `kafka.teardown` 274ms, `mongo.teardown` 278ms) still ran to completion (per-step timing instrumentation added temporarily to confirm this, then removed). An earlier arming attempt that additionally skipped the *real* `nats.teardown()` call (to test two failures at once) produced a second, competing `Failed Suites` hook-timeout report from `kafka.teardown()` hanging — traced to leaving the real NATS container/connection open, not to F5's fix; once every real step actually runs, teardown completes in under a second total and no second report appears. All arming edits reverted; `git diff` on the spec and `nats-stream-signal.adapter.ts` confirmed empty before the final run.

### Final verification (post-fix)

- `pnpm --filter @otc/gateway run typecheck` — clean.
- `eslint` on the 4 changed files (`stream.integration.spec.ts`, `stream-projector-e2e.integration.spec.ts`, `sse-test-client.ts`, `spawn-real-projector.ts`) — clean, 0 output.
- Gateway unit suite: **28 files / 114 tests, all green**.
- Gateway integration suite (`vitest.integration.config.mts`, real Testcontainers): **6 files / 34 tests, all green**, Duration 49.10s.
- `stream-projector-e2e.integration.spec.ts` alone, 3 independent runs: all green (~21-23s each), confirming the new `node dist/main.js` boot path is stable, not a one-off.
- Root `pnpm quality` (`eslint .` + `pnpm -r typecheck` + `pnpm -r test`): **green across all 10 workspace packages** — exit code 0.
- `./init.sh`: exits 0.
- No `apps/projector` source file touched (`git status --porcelain apps/projector` empty); no commit made.

---

## Post-approval refinement: `ping`/`stream.ready` frames no longer carry `id:` (hand-testing finding)

### The finding

`stream.controller.ts`'s `writeFrame` put an `id:` line on **every** frame, `ping` included. Per the SSE spec any dispatched event carrying an `id:` line updates a browser `EventSource`'s `lastEventId`, heartbeat or not. `ping` fires every `GATEWAY_SSE_PING_INTERVAL_MS` (15s default) while real content is comparatively rare, so a real client's remembered `lastEventId` was, most of the time, a ping's — and a ping's minted cursor is never pushed into the replay buffer (`StreamHub.mintCursor()`'s docstring), so reconnecting with it always answered `resumed: false`, even when nothing was actually missed. `specs/shared/openapi.yaml`'s "Frame format"/"Event types" sections were amended (by the leader, before this refinement) to state the intended contract: `order.updated`/`timeline.appended` carry `id`, `stream.ready`/`ping` do not.

### What changed

**`apps/gateway/src/presentation/stream.controller.ts`**

- `writeFrame`'s signature: `id: string` → `id: string | null`. When `id === null`, no `id:` line is written at all (only `event:`/`data:`).
- The `stream.ready` call site now passes `null` for `id` (the cursor is still computed and still appears inside the frame's `data.cursor` field — only the wire `id:` line is gone).
- The `ping` call site now passes `null` for `id`. `this.hub.mintCursor()` is still called (for its side effect of advancing the shared cursor sequence, consistent with `StreamHub`'s existing "minted but never stored" contract for this event type) but its return value is discarded rather than written to the wire.
- `order.updated`/`timeline.appended` call sites are untouched — they still pass `frame.cursor` (a real `string`) and still get an `id:` line.

**`apps/gateway/src/test-support/sse-test-client.ts`** (the concrete parser blocker named in the brief)

- `SseFrame.id`: `string` → `string | undefined`.
- `parseSseFrames`'s block-accept condition dropped `idLine &&` — a block now parses as a frame if it has `event:` and `data:` lines, with `id: idLine?.[1]` (`undefined` when absent) rather than being silently discarded.

### Raw wire evidence

Captured via a temporary `SSE_DEBUG_CAPTURE` env-gated `process.stderr.write` in `sse-test-client.ts`'s `data` handler (added, used once, then reverted — `git diff` on that file confirmed clean afterward), running the pre-existing F7 ping test:

```
[RAW CHUNK] "event: stream.ready\n"
[RAW CHUNK] "data: {\"cursor\":\"1787740962418-1\",\"resumed\":false,\"orderId\":null}\n\n"
[RAW CHUNK] "event: ping\n"
[RAW CHUNK] "data: {\"at\":\"2026-08-26T10:42:42.619Z\"}\n\n"
[RAW CHUNK] "event: ping\n"
[RAW CHUNK] "data: {\"at\":\"2026-08-26T10:42:42.819Z\"}\n\n"
```

Neither `stream.ready` nor `ping` carries an `id:` line on the wire — confirmed directly, not inferred from the parser.

### New regression test

`apps/gateway/src/stream.integration.spec.ts`, inside the "ping heartbeat (F7, review finding)" describe block (the only one with a short, 200ms ping interval):

**`'F: ping frames carry no id, and reconnecting with a real content frame's id still resumes (review finding, hand-tested)'`**

Connects, publishes a real `order.updated` fact, waits for a `ping` frame arriving *strictly after* the content frame in arrival order (not merely "a ping was seen somewhere"), asserts the content frame's `id` is defined and the ping's `id` is `undefined`, then reconnects using the content frame's `id` as `Last-Event-ID` and asserts `resumed: true` — reproducing the human's own hand-test end to end.

**Armed failure (verbatim)**, produced by temporarily reverting only the `ping` call site back to `writeFrame(res, this.hub.mintCursor(), 'ping', ...)`:

```
FAIL  src/stream.integration.spec.ts > Gateway SSE stream — ping heartbeat (F7, review finding) > F: ping frames carry no id, and reconnecting with a real content frame's id still resumes (review finding, hand-tested)
AssertionError: expected '1787740552968-3' to be undefined

- Expected:
undefined

+ Received:
"1787740552968-3"

 ❯ src/stream.integration.spec.ts:303:28
      301|
      302|       expect(contentFrame.id).toBeDefined();
      303|       expect(pingFrame.id).toBeUndefined();
```

(That same arming run also surfaced a secondary hook-timeout in `afterAll` — because the failed assertion threw before the still-open first HTTP socket was destroyed, and `testApp.close()` waited on it. Fixed as part of this refinement, not left as a known issue: the test now tracks both request handles outside the `try` block and destroys them unconditionally in a `finally`, alongside the pre-existing NATS `publisherConnection.close()`.) All edits reverted before the final run; `writeFrame`'s `ping` call site restored to pass `null`.

### Pre-existing test confirmed still green

`'sends a ping frame on the configured interval, with a well-formed StreamPing body'` (F7) — asserts only `event`/`data` on ping frames, never `id`, so it required no change and passed both before and after this refinement, verified directly rather than assumed.

### Traceability

No new `R<n>` — this is a wire-format correction to R55's existing reconnection contract (`specs/shared/openapi.yaml`'s "Frame format"/"Event types" sections, already amended by the leader). `test-matrix.md` unaffected.

### Verification

- `pnpm exec tsc --noEmit -p apps/gateway/tsconfig.json` — clean.
- `pnpm exec eslint apps/gateway` — clean, 0 output.
- Gateway unit suite (`vitest run`): **28 files / 114 tests, all green** (run twice).
- `stream.integration.spec.ts` alone: **7/7 green**, run three times (once to confirm the fix, once armed-failing, once to confirm restored).
- `stream.integration.spec.ts` + `stream-projector-e2e.integration.spec.ts` together: **8/8 green**.
- Full gateway integration suite (`vitest.integration.config.mts`, real Testcontainers): **6 files / 35 tests, all green**, run twice in a row (53.72s, then 60.60s).
- `feature_list.json` untouched; no commit made.

### Files touched

- `apps/gateway/src/presentation/stream.controller.ts`
- `apps/gateway/src/test-support/sse-test-client.ts`
- `apps/gateway/src/stream.integration.spec.ts`
