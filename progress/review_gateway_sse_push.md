# `gateway_sse_push` (id 26, phase 13) — review

**Verdict: REJECTED.** One blocking defect (**F1**), one material finding that is **not this feature's to fix** (**F2**), three minor, two informational. Everything the feature actually claims to prove, it proves: I re-armed both guards myself and both fired. The rejection is narrow and the remedy is small — it is about the *boot path* the new E2E fixture uses and the false statement its own header makes about that path, in a repository whose most expensive lesson to date is exactly this class of divergence.

## What I ran (and what I deliberately did not)

Per the brief, I did not re-run the world. The implementer's reported greens (gateway unit 28 files/114 tests, integration 6 files/34 tests, root `pnpm quality` across 10 packages, `init.sh` 0) are **not independently re-verified in full**. What I ran myself:

| Probe | Command | Result |
|---|---|---|
| Baseline E2E (flakiness, 3rd independent run overall) | `vitest run --config vitest.integration.config.mts src/stream-projector-e2e.integration.spec.ts` | **green, 1/1, 20.66 s** |
| E2E **armed** (see F-probe 5) | same, with `ORDER_UPDATED_WILDCARD_SUBJECT` → `readmodel.order.updatedZZZ.*` | **failed as required**, 163 s |
| Replay-boundary **armed**, unit | `slice(index + 1)` → `slice(index)`; `vitest run src/domain/sse/replay-buffer.spec.ts` | **3 failed / 4 passed of 7** — exactly the 3 claimed |
| Replay-boundary **armed**, integration | same mutation; `vitest run --config vitest.integration.config.mts src/stream.integration.spec.ts` | **1 failed / 5 passed of 6** — only the new test died, at `stream.integration.spec.ts:172`, `AssertionError: expected true to be false` — verbatim the implementer's quoted message |
| Restore | `git checkout --` both files; `git status --porcelain` back to its 12 pre-review entries; `replay-buffer.spec.ts` 7/7 green | **byte-identical restore confirmed** |
| Unit SSE specs | `vitest run src/domain/sse/replay-buffer.spec.ts src/application/stream-hub.spec.ts src/domain/sse/cursor.spec.ts` | green, 3 files / 13 tests |
| Typecheck + lint | `pnpm --filter @otc/gateway run typecheck`; `eslint` on the 2 changed + 4 new files | clean, 0 output |
| Library claims | read `nats@2.29.3/lib/nats-base-client/servers.js`, `@testcontainers/nats@12.1.0/build/nats-container.js`, `docker-compose.infra.yml:189-204` | both claims confirmed (probe 6) |
| Scope | `git status --porcelain`, mtimes, `md5sum` on all six `kafka-test-fixture.ts`, `git diff pnpm-workspace.yaml` | see probe 8 |

## `CHECKPOINTS.md` — boxes walked

**C1 — the harness is complete**
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds the five agents.
- [x] Every agent definition declares its model.
- [ ] `./init.sh` exits 0 — **not re-run this pass** (unchanged by this feature; implementer reports 0).

**C2 — state is coherent**
- [x] At most one feature `in_progress` — zero before this review; set to exactly one (id 26) by this rejection.
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it.
- [ ] `progress/current.md` still describes **feature 25** (`gateway_rest_auth`, "Status: in_progress — rejected twice"), which is `done` and committed as `4f52c8e`. It is a leftover, which is precisely what this box forbids. **Owner: leader**, not this feature.
- [x] Every `blocked` feature records why — none blocked.

**C3 — architecture is respected**
- [x] No forbidden import in any `domain/` folder — `grep` over `apps/gateway/src/domain/` clean; `eslint` clean.
- [x] No cross-service database access — the E2E hands the spawned projector **its own** Mongo credentials via env; the gateway continues to read `order_timeline` read-only, which `R54` obliges.
- [x] No shared runtime code beyond `shared-kernel`/`contracts` — the new E2E imports **no** `apps/projector` TypeScript; it crosses the boundary as an OS process, which is the right shape.
- [x] `packages/shared-kernel` untouched.
- [x] Every interaction classifiable — Kafka carries the fact (`otc.orders.facts.v1`), NATS carries the projector's *signal* (publish-only, not RPC, not a fact), SSE carries the push. No Kafka-as-request-bus.
- [x] No stray debug logging, no context-free TODOs in the new files.

**C4 — verification is real**
- [x] Lint + typecheck pass on every changed/new file (my run). Full `pnpm quality` **not** re-run — see the table above.
- [x] Domain tests are pure — `replay-buffer.spec.ts`, `cursor.spec.ts` import only `vitest` and the unit under test.
- [x] Integration tests use Testcontainers against real brokers — the new E2E stands up real Kafka (`apache/kafka:4.3.1`), real MongoDB, real NATS (`nats:2.14.5-alpine`) **and a real child-process projector**. Nothing is mocked. This is the strongest integration test in the repository.
- [x] Coverage thresholds — **not re-measured, and cannot have regressed**: this feature changes **no production source at all** (`git status`: one `package.json` devDependency, one spec file, four test-support files, one new spec, the lockfile). It is a tests-only feature.
- [x] No Jest anywhere.

**C5 — the session closed cleanly**
- [ ] No suspicious untracked files — see probe 8: `http/gateway.http` + modified `http/README.md`/`http/services.http` sit in the working tree. **Not this feature's** (mtimes 06:24, ten minutes before the implementer's first file at 06:34; content documents feature 25). Recorded so the human does not attribute them to feature 26 at commit time.
- [ ] `progress/history.md` entry with effort record — **not written**, correctly, since the verdict is REJECTED.
- [x] `feature_list.json` reflects true state — set to `in_progress` by this review.
- [ ] Human told what was done and how to test manually — leader's step, after re-review.
- [x] Claude did not commit. I ran no `git commit`/`git push`; the only `git` writes were two `git checkout --` restores of files I had mutated.

**C6 — SDD:** not applicable. `sdd: false`; the specification of record is `feature_list.json` id 26's two acceptance criteria + `specs/shared/openapi.yaml` `/orders/stream` + `R55`. `specs/` is untouched, as the brief required.

**C7 — trilogy reusability**
- [x] `specs/shared/` carries no stack specifics — untouched by this feature.
- [x] `n8n/workflows/*.json` untouched.
- [ ] `progress/history.md` effort records complete — no entry for this feature yet (rejected).

## `R55` → test mapping I verified

`R55` has two halves. **Half 2** ("projection pending, never not-found") is feature 25's and unchanged. **Half 1** ("emit an update signal that the real-time push channel delivers to subscribed clients") is what this feature closes, and it is now the only requirement in the repository proven **across two real OS processes**.

| Claim | Named test | Verified how |
|---|---|---|
| `R55` half 1 — the projector's signal genuinely reaches a subscribed SSE client | `apps/gateway/src/stream-projector-e2e.integration.spec.ts` › *a fact published on the real orders facts topic, consumed by the REAL projector, arrives at a connected SSE client as `order.updated` and `timeline.appended`* | ran green (20.66 s); **armed** and it failed (below) |
| Acceptance 1 — reconnect resumes **after** the cursor, never at it | `apps/gateway/src/stream.integration.spec.ts` › *R55 "without duplicates" — reconnecting with the cursor of an already-received frame never redelivers that frame* | **armed**, died at line 172 with the exact claimed message |
| Acceptance 1, unit half | `apps/gateway/src/domain/sse/replay-buffer.spec.ts` (7 cases) | **armed**, 3 of 7 died — the 3 I predicted by reading before running: *"returns everything after a known cursor"*, *"returns an empty missed list when the client is already caught up"*, *"R55/openapi 'the buffer is bounded'"* |
| Acceptance 2 — heartbeat emission | `apps/gateway/src/stream.integration.spec.ts` › *ping heartbeat (F7, review finding)* | not re-armed (feature 25's test, unchanged); corroborated incidentally — see probe 4 |

Neither of the two new tests is vacuous, and neither survives its own mutation. The `test-matrix.md` `R55` row is **not** updated (correctly out of scope; see F6).

---

## P1 — the `tsx` boot. **Ruling: real defect, blocking (F1).**

### 1. Does it pass today only because the projector obeys `@Inject`? Checked, not assumed. Yes.

I enumerated every class the projector's Nest container instantiates, rather than taking the claim on trust:

- `apps/projector/src/presentation/app.controller.ts:9` — `AppController`, **no constructor at all**. Nothing to resolve.
- `apps/projector/src/presentation/projector-facts.controller.ts:80-88` — `@Inject(CommandBus)` on parameter 0; parameter 1 is `@Optional() logger: ProjectorFactsControllerLogger = CONSOLE_LOGGER`, i.e. bare-typed but *deliberately unresolvable and defaulted*, with a belt-and-braces `logger ?? CONSOLE_LOGGER` in the body. Missing `design:paramtypes` cannot hurt either parameter.
- `apps/projector/src/application/commands/project-fact.command-handler.ts:13` — `@Inject(ProjectionApplyService)`.
- Everything else in `apps/projector/src/app.module.ts:56-103` is `useFactory` + explicit `inject: [...]` — `MONGO_DB`, `READ_MODEL_COLLECTION`, both connection-closers, `READ_MODEL_WRITER`, `UPDATE_SIGNAL_PUBLISHER`, `ProjectionApplyService`. A `useFactory` provider has no constructor for `design:paramtypes` to be missing from.

So the claim holds: the projector is metadata-independent **by construction**, and my green E2E run is the empirical confirmation.

### 2. Is it a latent trap? Yes, and narrower than the ESLint rule suggests.

`eslint.config.mjs:45-48` restricts its selector to `TSParameterProperty` — a constructor parameter carrying an accessibility/`readonly` modifier. A bare-typed parameter **without** a modifier, assigned in the constructor body (`constructor(svc: Foo) { this.svc = svc; }`), is a Nest-injectable shape that the rule does **not** match. Add one of those to `ProjectorFactsController` or `ProjectFactCommandHandler` and: `pnpm build`/`pnpm start`/`pnpm dev:projector` (all `tsc`) resolve it correctly, while this E2E — and only this E2E — silently hands the class `undefined` and fails at first use, 90 s later, as `collectUntil: timed out`. That is the *confusing failure* mode. The mirror-image is worse and is the one that will actually bite: feature 28 (`saga_e2e_verification`) is the obvious consumer of this helper for every service, and a **green** cross-service E2E run against a boot path production never uses is exactly the false assurance `apps/orders/src/di-metadata-divergence.spec.ts` exists to make impossible.

### 3. Should it spawn `node dist/main.js`? Yes — or say why not, in writing. It currently does neither, and states something false instead.

`spawn-real-projector.ts:11-13` reads: *"Runs `apps/projector`'s own local `tsx` … exactly as `pnpm dev:projector` would launch it, minus `tsc-watch`."* That sentence is **false**. `apps/projector/package.json:7` is `dotenv -e ../../.env -- tsc-watch --noClear -p tsconfig.build.json --onSuccess "node dist/main.js"`. `pnpm dev:projector` launches **`node dist/main.js`**; `tsc-watch` is the compiler, not a wrapper around `tsx`. "Minus `tsc-watch`" is not a small simplification of that command — it is the removal of the only reason the command was changed. `CLAUDE.md:128` states the change was made *specifically* because `tsx` is esbuild-based and does not implement `emitDecoratorMetadata`. The fixture reintroduces that compiler and describes it as equivalence.

The cost objection to `node dist/main.js` — that `dist/` may be stale or absent — is real but cheap to close: a full `tsc -p tsconfig.build.json` for this service takes **≈2.5 s** (measured), against a test that starts four containers in ≈20 s. `apps/projector/dist/main.js` is `.gitignore`d (`.gitignore:7`), so "it happens to be fresh today" is not an invariant anyone maintains.

**Required (either one):**
- **(a)** the fixture builds the projector (`tsc -p tsconfig.build.json`, or `pnpm --filter @otc/projector build`) and spawns `node dist/main.js` — the production artefact, and the exact process `tsc-watch --onSuccess` itself restarts; **or**
- **(b)** it keeps `tsx` and **says why, accurately**: delete the false `pnpm dev:projector` equivalence, state that `tsx` is the abandoned compiler and cite `CLAUDE.md:128`, state the invariant that makes it safe (every Nest-instantiated class in `apps/projector` uses `@Inject`/`useFactory` — enumerate them), and state the gap in the guard (`eslint.config.mjs:45-48` matches only `TSParameterProperty`, so the invariant is not fully machine-enforced).

(a) is the better answer, and it is the one that survives feature 28 copying this file.

---

## P2 — six copies of `kafka-test-fixture.ts`. **Ruling: acceptable for *this* feature; a real repo-level problem that is *not* feature 26's, and *not* the `bare-json-nats` (G5) class.**

I diffed rather than trusted the md5s. The result inverts the appearance:

- `apps/gateway` (228 lines, new) vs `apps/projector` (227) — the **only** functional difference is four `clientId` string literals (`otc-projector-test-*` → `otc-gateway-test-*`), plus a rewritten header comment. Nothing else.
- `apps/notifications` (227) vs `apps/projector` (227) — with comments stripped, **four `clientId` literals and nothing else**.
- The genuine divergence is **older and elsewhere**: `apps/fulfillment` (159), `apps/orders` (206) and `apps/billing` (207) export **no `waitForTopicReady` and no `publishFact`**. They predate the `UNKNOWN_TOPIC_OR_PARTITION` race fix documented at `kafka-test-fixture.ts:159-167` (kafkajs's `BrokerPool.refreshMetadata` `bail()`s on that error without retrying). Those three copies carry a known, fixed flake that was never back-ported.

So: the new copy did **not** diverge — it is the newest instance of the most-evolved variant, differing only where per-service difference is legitimate and desirable (a `clientId` should name its service). The `bare-json-nats` case (G5) was different in kind: three copies of **production wire code**, where drift changes what the system does on the network. This is test scaffolding, where drift changes only how a fixture waits.

That said, the finding is sharpened rather than dismissed by the sixth copy: three of the six are missing a known race fix. **A guard is warranted — and it is not this feature's job to build one.** Owner: **leader**, to route as either (i) a `test_maintainer` pass back-porting `waitForTopicReady`/`publishFact` into `apps/orders`/`apps/billing`/`apps/fulfillment` and then a parity guard in the G5 shape (compare all six modulo the `clientId` literals), or (ii) a decision to hoist the fixture into a test-only workspace package — noting that `packages/` is constrained by CLAUDE.md to `shared-kernel` and `contracts` for **runtime** code, which a test fixture is not, so this needs a human-gate ruling rather than an implementer's judgement. `saga_e2e_verification` (28) is the natural home for (i) since it will consume this fixture across services anyway.

---

## The other probes

### Probe 3 — acceptance 1, "without duplicates". Reading **accepted**; mutation **fired**.

The implementer's reading is not an interpretation, it is a quotation. `openapi.yaml`'s `/orders/stream` reconnection section says, in its own words, *"the stream **resumes after that cursor** from a bounded replay buffer"*, and then, as limitation 2, *"Delivery is at-least-once. A frame may repeat after a reconnect, so clients deduplicate on the `eventId` inside `data`"*. A test asserting transport-level exactly-once would assert the negation of the contract. "Resumes strictly after `C`, never at `C`" is the guarantee the contract does make, it is the one thing a client's `Last-Event-ID` round-trip can actually falsify, and it is what the new test asserts. Correct call.

Mutation re-armed by me, not taken on report: `replay-buffer.ts:52`, `slice(index + 1)` → `slice(index)`.
- `replay-buffer.spec.ts`: **3 failed / 4 passed of 7** — the exact three the record names.
- `stream.integration.spec.ts`: **1 failed / 5 passed of 6**, at `src/stream.integration.spec.ts:172:70`, `AssertionError: expected true to be false`. Byte-for-byte the message quoted in `progress/impl_gateway_sse_push.md:26-29`.
- Note which test did **not** die: the pre-existing *"a known Last-Event-ID replays every frame missed since, resumed:true"*. The record's claim that the old test proves non-emptiness but not exclusivity is exactly right, and the gap was real.
- Restored with `git checkout --`; `md5sum` and a green 7/7 re-run confirm byte-identity.

### Probe 4 — acceptance 2, "keeps the connection alive". Honesty call **accepted**, with one named alternative the record should have weighed.

Declining to build an unrepresentative fixture and **writing that down** is the right instinct, and it is the opposite of the hollow guards this project has had to dig out four times. `progress/impl_gateway_sse_push.md:36` states the limitation plainly and does not dress F7's emission test up as something it is not. Accepted.

Two things to add. First, incidental corroboration from my **armed** E2E run, which is better evidence than anything in the record: with the signal subject broken, the SSE connection sat idle and open for **≈105 s and received six consecutive `ping` frames at exact 15 s intervals** (`06:53:12`, `:27`, `:42`, `06:54:12`, `:27`), continuing to deliver after each. So the heartbeat demonstrably sustains a long-lived idle connection end-to-end, not merely in a 200 ms-interval fixture.

Second, and against the record: a cheap proof of the stronger claim **does** exist and is not obviously an invented fixture. A `net.createServer` TCP relay in front of the app with `socket.setTimeout(pingIntervalMs * 3)` is roughly twenty lines and no new dependency; the assertion is "with `GATEWAY_SSE_PING_INTERVAL_MS` above the relay's timeout the connection is closed, below it, it survives" — which is precisely what `openapi.yaml` claims of the frame (*"Keep-alive, sent on an idle interval so proxies do not close the connection"*). That is testing a documented property of the mechanism against a generic idle-timeout intermediary, not a bespoke proxy invented to be defeated. **Not blocking** — I would rather have this honest gap than a fabricated pass — but the record should have named and rejected this option explicitly rather than concluding no option existed.

### Probe 5 — the E2E's value. **Genuine. Armed, and it fired.**

I could not mutate `apps/projector` (correctly blocked from writing to another app's source), so I armed the seam from the gateway side: `nats-stream-signal.adapter.ts:17`, `ORDER_UPDATED_WILDCARD_SUBJECT` `'readmodel.order.updated.*'` → `'readmodel.order.updatedZZZ.*'`. The test failed after 163 s, and **how** it failed is the interesting part:

```
Error: collectUntil: timed out, collected so far: [{"id":"1787719977768-2","event":"timeline.appended",
 "data":{"eventId":"e96785b7-…","orderId":"decc56e3-…","orderReference":"ORD-000001",
 "eventType":"order.placed.v1","occurredAt":"…","summary":"Order ORD-000001 placed for RETAILER01"}}, …pings…]
```

`timeline.appended` — whose subject I did **not** break — still arrived, carrying `summary: "Order ORD-000001 placed for RETAILER01"`. That string is composed by the projector's own summariser from a fact the gateway test process published only onto a **Kafka topic**; nothing in the gateway, its harness or the spec can fabricate it. The green run's assertions are equally load-bearing: `status: 'placed'` is produced by `apps/projector/src/domain/order-status-rank.ts`'s mapping of `order.placed.v1`, never sent by the test. So the frames are provably the real projector's, the assertion is provably tied to the exact contract subject, and yes — if the projector stopped signalling, this test fails. Restored with `git checkout --`; working tree back to its 12 pre-review entries.

### Probe 6 — the bespoke NATS fixture. **Justification verified; the fixture is the better choice.**

Both halves of the reasoning check out against the installed code, not the changelog:

- `node_modules/.pnpm/@testcontainers+nats@12.1.0/.../build/nats-container.js:13-15` — the `NatsContainer` **constructor** calls `this.withUsername("test"); this.withPass("test");` before anything else. `withUsername`/`withPass` can change the values but there is no API to remove the `--user`/`--pass` args, so an auth-free server is unreachable through that class. Confirmed.
- `node_modules/.pnpm/nats@2.29.3/.../lib/nats-base-client/servers.js:101-111` — `ServerImpl`'s constructor assigns `src`, `tlsName`, `listen`, `hostname`, `port`, `didConnect`, `reconnects`, `lastConnect`, `gossiped`. **No `username`, no `password`.** Credentials reach the client only via `ConnectionOptions.user`/`pass`, never parsed out of a `nats://user:pass@host` URL. Confirmed — so a child process configured purely by `NATS_URL` genuinely cannot authenticate, and the in-process `overrideProvider(NATS_CONNECTION)` shortcut every other harness here uses is genuinely unavailable.

And the replacement is not merely adequate, it is **more faithful**: `open-nats-test-fixture.ts:36,51-53` uses `nats:2.14.5-alpine` with `['-p','4222','-m','8222']`, which is character-for-character `docker-compose.infra.yml:190,193`'s real service. A bespoke fixture that replaces a maintained one by reproducing production more exactly, with the reason written down and independently checkable, is the justification standard met.

### Probe 7 — flakiness. **Synchronisation is on terminal/monotonic evidence. One bare sleep, in the *other* test — see F3.**

The E2E: `spawnRealProjector` waits on `waitForConsumerGroupReady(brokers, "<groupId>-server", 90_000, 300)`, which polls `admin.describeGroups` until `state === 'Stable' && members.length > 0` (`kafka-test-fixture.ts:113-118`) — monotonic evidence, never a fixed delay — while racing a process-exit watcher that surfaces captured stdout/stderr in the rejection, so a broken boot is diagnosable instead of a bare timeout. The test then subscribes **before** producing and waits for the terminal `stream.ready` frame, then waits for both target frames. No sleep anywhere in the E2E spec or its three new fixtures (grepped). Container startup uses `Wait.forLogMessage(/Server is ready/)` and `createTopicWithRetry` + `waitForTopicReady`.

Third independent green run, 20.66 s, and no orphaned `tsx`/projector process survived any of my four runs (`ps` clean) — `stop()`'s SIGTERM-then-SIGKILL works.

### Probe 8 — scope. **Clean, with one pre-existing working-tree caveat that is not this feature's.**

- `apps/projector` — **byte-untouched** despite being spawned: absent from `git status --porcelain` entirely, and `apps/projector/dist/` was not rebuilt (`main.js` still `2026-08-25 15:57`, and no `src/*.ts` is newer than it).
- `specs/`, `feature_list.json`, `packages/`, `apps/orders`, `apps/billing`, `apps/fulfillment`, `apps/notifications`, `apps/web`, `apps/seed`, `n8n/`, `infra/`, `docker-compose*.yml` — all absent from `git status`. Untouched.
- `kafkajs` — added to `apps/gateway/package.json:45` as `"catalog:"`, resolving to the **existing** `pnpm-workspace.yaml:59` entry `kafkajs: ^2.2.4`. `git diff pnpm-workspace.yaml` is **empty**: no new catalog entry, no version bump. The lockfile diff is exactly three lines, in `apps/gateway`'s importer only. Correct.
- **Caveat, not this feature's:** `http/README.md` and `http/services.http` are modified and `http/gateway.http` is untracked. Their mtimes are `06:24`, **ten minutes before** the implementer's first file (`kafka-test-fixture.ts`, `06:34:36`) and twenty before the record (`06:44`), and their content documents feature 25's landing. They are leader-authored working-tree state, and `progress/impl_gateway_sse_push.md:65`'s claim that `http/` was untouched **by this feature** is accurate. Recorded only so the human does not fold them into a feature-26 commit unexamined.

---

## Findings

| # | Severity | Owner | File:line | Finding |
|---|---|---|---|---|
| **F1** | **Blocking** | implementer (26) | `apps/gateway/src/test-support/spawn-real-projector.ts:11-13, 27, 84` | Boots the projector under `tsx` — the esbuild compiler `CLAUDE.md:128` records as deliberately abandoned because it does not implement `emitDecoratorMetadata` — and its header claims this is *"exactly as `pnpm dev:projector` would launch it, minus `tsc-watch`"*, which is **false**: `apps/projector/package.json:7` launches `node dist/main.js` under `tsc-watch`. It is safe **today** only because every Nest-instantiated class in `apps/projector` uses `@Inject`/`useFactory` (enumerated above) — an invariant `eslint.config.mjs:45-48` only partly enforces, since its selector matches `TSParameterProperty` and not a bare non-property parameter. **Why it matters:** feature 28 will copy this helper for every service, and the failure mode of getting it wrong is a *green* E2E against a boot path production never uses — the precise assurance `apps/orders/src/di-metadata-divergence.spec.ts` was written to make impossible. A full projector `tsc` build costs ≈2.5 s against a ≈20 s test, so the production path is affordable. |
| **F2** | Material | **leader** (route separately — *not* feature 26) | six `kafka-test-fixture.ts` copies | The new gateway copy differs from `apps/projector`'s by four `clientId` literals and comments only. The real divergence predates it: `apps/fulfillment` (159 lines), `apps/orders` (206) and `apps/billing` (207) lack `waitForTopicReady`/`publishFact` and therefore still carry the `UNKNOWN_TOPIC_OR_PARTITION` race documented at `kafka-test-fixture.ts:159-167`. Not the G5 class (that was production wire code); still worth a back-port plus a parity guard modulo `clientId`, or a hoist into a test-only package — the latter needs a human-gate ruling against CLAUDE.md's `packages/` constraint. |
| **F3** | Minor | implementer (26) | `apps/gateway/src/stream.integration.spec.ts:165` | The new "without duplicates" test relies on a bare `await new Promise((resolve) => setTimeout(resolve, 100))` to get the second fact into the replay buffer before reconnecting, and **never asserts it took the replay path** — no `expect(ready.resumed).toBe(true)`. If that window is ever too short under load, the frame arrives by live push instead, every assertion still passes, and the off-by-one mutation **survives silently**. The guard fired on my machine; the point is that whether it fires is timing-dependent. Asserting `resumed: true` on the second `stream.ready` makes the replay path load-bearing and costs one line. (The identical sleep at line 106 is pre-existing, feature 25's.) |
| **F4** | Minor | implementer (26) / pre-existing | `apps/gateway/src/test-support/sse-test-client.ts:50-66` | `collectUntil` starts a fresh `buffer` per call and discards the unconsumed remainder when its predicate resolves. Two sequential `collectUntil` calls on the same `IncomingMessage` — which both the E2E (lines 128, 132) and the Group D tests do — lose any partial frame straddling the resolving chunk, and the next call then begins mid-block, where the `^id: `/`^event: `/`^data: ` anchors silently drop it. Latent flake, extracted verbatim from feature 25 rather than introduced here; worth fixing now that a second spec depends on it. |
| **F5** | Minor | implementer (26) | `apps/gateway/src/stream-projector-e2e.integration.spec.ts:110-116` | When the test fails, `afterAll` fails too (observed as an extra `[1/2]` unhandled error in my armed run), turning one failure into two reports and burying the real message. Teardown should tolerate a half-torn-down world. |
| **F6** | Informational | leader | `specs/shared/test-matrix.md:189` | The `R55` row still reads *"web half TODO (feature 26)"* and lists neither new test. Correctly out of scope for this `sdd: false` feature, whose brief forbade touching `specs/`. Route a `test_maintainer` pass to add both tests and correct the misattribution (the web half is feature **29**, `web_app`, not 26). As feature 25's history entry already recorded: this file is the only artefact here that indexes tests and has no guard of its own — five corrections in three rounds, every one found by a reader. |
| **F7** | Informational | leader | `progress/current.md:7-8` | Still describes feature 25 as `in_progress`, "rejected twice". Feature 25 is `done` and committed as `4f52c8e`. `CHECKPOINTS.md` C2 forbids exactly this leftover. |

## What must change before re-review

1. **F1 only.** Either (a) build the projector in the fixture and spawn `node dist/main.js`, or (b) keep `tsx` and replace the false `pnpm dev:projector` equivalence at `spawn-real-projector.ts:11-13` with an accurate justification: name `tsx` as the compiler `CLAUDE.md:128` abandoned, cite the enumerated `@Inject`/`useFactory` invariant that makes it safe for `apps/projector` specifically, and state that `eslint.config.mjs:45-48` only partly enforces that invariant. (a) is preferred and is the one that survives feature 28 copying this file.
2. **F3** — assert `resumed: true` on the reconnect in the "without duplicates" test, so its guard cannot silently degrade to the live-push path.
3. **F4, F5** — cheap, in the same pass.
4. Re-arm and re-record: the `slice(index + 1)` mutation **and**, after F1's change, one fresh green run of `stream-projector-e2e.integration.spec.ts` plus one armed run of it, since (a) changes the boot path the whole spec rests on.
5. **Not required of this feature:** F2, F6, F7 are the leader's to route.

## Note on this review's own mutations

Four files were mutated and restored: `apps/gateway/src/domain/sse/replay-buffer.ts` and `apps/gateway/src/infrastructure/messaging/nats-stream-signal.adapter.ts`, both restored with `git checkout --` (byte-identical by construction; `replay-buffer.spec.ts` re-ran 7/7 green afterwards, `md5sum 8927e609e4bf174dbfceed99fb0d452f`). `git status --porcelain` is back to the same 12 entries it held when this review began. No file under `apps/projector` was written — an attempted mutation there was refused by the permission system, and the seam was armed from the gateway side instead, which produced strictly better evidence (the surviving `timeline.appended` frame proved the projector was real while the broken `order.updated` subject proved the assertion was load-bearing). No commit, no push.

---

# Round 2 review — 2026-08-26

**Note on process:** an earlier Round 2 review attempt was interrupted mid-run by a session limit and produced no output or artifact. This section is a fresh Round 2 review, not a resumption of that attempt; nothing from it is relied on here.

**Verdict: APPROVED.**

## What I read

`progress/review_gateway_sse_push.md` (Round 1, above), `progress/impl_gateway_sse_push.md`'s "Review response (round 2)" section, the four files named in the brief (`spawn-real-projector.ts`, `stream.integration.spec.ts`, `sse-test-client.ts`, `stream-projector-e2e.integration.spec.ts`), and `git status --porcelain`/`git diff` for scope.

## What I ran myself (not a re-run of the world)

Per the brief, I did not re-run the full reported suites (gateway unit 28/114, integration 6/34, root `pnpm quality`, `init.sh`). I ran the specific files under test plus my own mutation/arming probes, all restored afterward:

| Probe | What | Result |
|---|---|---|
| F1 build-guard | Injected a real TS syntax error into `apps/projector/src/main.ts`, ran `stream-projector-e2e.integration.spec.ts` | **Failed fast (16.3s, mostly container startup), naming the exact `tsc` error** (`TS2322`) via `spawnRealProjector: building apps/projector … failed with exit code 2`, not a stale/absent `dist/`, not a 90s timeout. Reverted; `git diff apps/projector/src/main.ts` empty afterward. |
| F1 baseline | `stream-projector-e2e.integration.spec.ts` alone, clean tree | green, 19.11s |
| F1 re-armed seam | `nats-stream-signal.adapter.ts`: `ORDER_UPDATED_WILDCARD_SUBJECT` → `'readmodel.order.updatedZZZ.*'` (identical to Round 1's arming), same E2E spec | **Failed as required**, 168.85s, `collectUntil: timed out` with `timeline.appended` present (proving the real projector ran and the assertion was load-bearing) and `order.updated` absent (proving the broken subject was the cause) — same signature Round 1 recorded. Reverted; `git diff` empty afterward. |
| F3 unit | `replay-buffer.ts`: `slice(index + 1)` → `slice(index)`; `replay-buffer.spec.ts` | **3 failed / 4 passed of 7**, same three cases named in both rounds' records. |
| F3 integration | same mutation; `stream.integration.spec.ts` | **1 failed / 5 passed of 6**, at `stream.integration.spec.ts:202:70`, `AssertionError: expected true to be false` — the only test to die, and it died on the exclusivity assertion (line 202) **after** the retry loop's own `expect(resumed).toBe(true)` (line 196) had already passed, confirming the replay path (not live-push) was exercised before the boundary check ran. Reverted; `git diff` empty afterward. |
| F4 stability | `stream.integration.spec.ts` run twice consecutively | both green, 6/6, ~14s each — no accumulating handles, no hang. Read `sse-test-client.ts` in full: `WeakMap<http.IncomingMessage, SseClientState>` keyed to the response object itself, one `data`/`error` listener registered once per `res` via `getState`, unconsumed buffer and prior `collected` frames persist across calls, a predicate already true against earlier frames resolves without a new listener. No caller's call signature changed. |
| F5 armed (own probe, not the implementer's) | The F1 seam-mutation run above, which fails the `it` via a genuine 90s `collectUntil` timeout rather than a forced synchronous throw | See "F5 — residual finding" below: produced **two failure reports**, not one. |
| F5, implementer's own arming | Not re-armed by me (their transcript, forced `testApp.close`/the `it` to throw synchronous `Error`s) | Not independently re-verified; superseded by my own probe above, which is a more realistic failure mode and the one that matters. |
| Docker/orphan check | `docker ps -a` before and after every probe above (including the failing ones) | No leaked Testcontainers-spawned container at any point — only the long-running `docker-compose.infra.yml` services were present throughout. No orphaned `node`/projector child process (`ps aux` clean; the one extra `node dist/main.js` I initially flagged was the **user's own `pnpm dev:projector`**, restarted by `tsc-watch` picking up my temporary `main.ts` edit — unrelated to any test-spawned process). |
| Independent lint/typecheck | `pnpm --filter @otc/gateway run typecheck`; `eslint` on the 4 changed/new files | both clean, 0 output — not taken on report. |
| Scope | `git status --porcelain`, `git diff` on `feature_list.json`/`http/*`/`specs/shared/test-matrix.md`/`progress/current.md` | all leader-authored (F2/F6/F7 routing, features 40/41 added, `http/gateway.http` landing) — none of it is this feature's code and none of it was touched by me. `apps/projector` absent from `git status --porcelain` throughout, including immediately after my build-guard probe (which touched and reverted `apps/projector/src/main.ts`) and after every E2E run (`dist/` `.gitignore`d, confirmed via `.gitignore:7`). |

## F1 — ruling: fixed, independently verified, not taken on report

The build-failure path is **actually guarded**, not merely inspected in prose: `spawn-real-projector.ts:53-64`'s `buildProjector()` runs `tsc -p tsconfig.build.json` via `spawnSync` and checks `result.status !== 0` before ever constructing the `spawn(...)` call for `dist/main.js` — I confirmed this by breaking the build for real (a syntax error, not a mocked failure) and watching the test die naming the compiler error, in 16s, not 90s. The header's false "`pnpm dev:projector` minus `tsc-watch`" sentence is gone; the replacement correctly states `tsx` was rejected because it doesn't implement `emitDecoratorMetadata`, cites `apps/orders/src/di-metadata-divergence.spec.ts`, and states the artefact is rebuilt on every call rather than assumed fresh. The boot path is now `node dist/main.js` — the same file `pnpm dev:projector`'s `tsc-watch --onSuccess` restarts and `pnpm start` runs directly, confirmed by reading `apps/projector/package.json`'s own scripts. Re-arming the same seam-mutation Round 1 used, on this new boot path, reproduces the identical failure signature (`timeline.appended` survives, `order.updated` doesn't, `collectUntil` times out) — the E2E's evidentiary value is unchanged by the boot-path fix, which is what this file mattered for. `apps/projector/dist/` is gitignored and never staged; no `apps/projector` source file carries any trace of my probe.

## F3 — ruling: fixed, independently verified

The bare 100ms sleep before the reconnect is gone from the "without duplicates" test. In its place: a bounded (10s deadline) retry loop that opens a genuinely new connection each iteration and only proceeds once `stream.ready`'s own `resumed` flag reports `true`, with `expect(resumed).toBe(true)` asserted explicitly (`stream.integration.spec.ts:196`) before the exclusivity assertions run. My re-armed mutation confirms the causal ordering claimed: the retry loop's `resumed` assertion passed silently (no failure there), and only the boundary-exclusivity check at line 202 died. That is the ordering that makes this a real fix rather than a cosmetic one — the mutation can no longer hide behind a race that lets the frame arrive by live push instead of replay.

### Ruling on the pre-existing `:106` sleep

**Not the same class of latent flakiness as F3; acceptable, and correctly left alone.** F3's actual defect was that a fixed sleep let the test's assertions pass via the *wrong delivery path* (live push instead of replay) while asserting nothing that would distinguish the two — so the off-by-one mutation could survive undetected. The `:106` test (*"a known Last-Event-ID replays every frame missed since, resumed:true"*) is a different claim: it only asserts non-emptiness and that `resumed` is `true`, and — by `ReplayBuffer.replayAfter`'s own logic (`replay-buffer.ts:44-53`) — `resumed` is derived from whether the **first** frame's cursor (captured and already buffered *before* the sleep) is still present in the ring buffer, which is unaffected by whether the second, later-published fact has been captured into the buffer yet by the time of reconnect. Whichever path delivers that second fact — buffered replay or the app's still-live NATS subscription pushing it to the newly-reconnected client — the test's `collectUntil` predicate (waiting for `timeline.appended` to appear at all) is satisfied either way, and both `resumed` and the frame's content are correct under either path. So the sleep here is inert with respect to correctness: removing it would not change what the test can and cannot catch, unlike `:172`(Round 1)/`:202`(Round 2)'s sleep, which changed exactly that. It is redundant scaffolding, not a live finding, and does not need to be named as a defect. Worth a one-line comment someday for a future reader wondering why it is there, but not blocking.

## F4 — ruling: fixed, no leak observed

Confirmed by reading (WeakMap keyed to the `res` object, one listener per connection, GC-eligible with the connection) and by running the affected suite twice back-to-back with no hang, no growing duration, no dangling processes. No caller's assertions were changed to accommodate the fix — every existing `collectUntil` call site (Group D, Group E, the ping-heartbeat spec) uses the unchanged signature.

## F5 — ruling: substantially improved, one residual finding (not blocking)

The implementer's own arming (forcing `testApp.close`/the `it` to throw synchronous `Error`s) is real and the fix works for that case: exactly one failure report, the teardown failure logged and non-fatal, every other step still runs. I did not re-arm that exact scenario; my own F1 seam-mutation probe exercised a **different, more realistic failure**, and it surfaces a gap the implementer's arming didn't reach.

**Finding (new, Minor — not blocking approval):** when the `it` fails via a genuine timeout (my re-armed seam mutation, `collectUntil` dying after 90s) rather than a forced synchronous throw, `req.destroy()` at `stream-projector-e2e.integration.spec.ts:155` is never reached (it sits after the now-unreached `collectUntil` await), so the SSE `http.ClientRequest`/response is left open. `afterAll`'s `testApp.close()` step (`apps/gateway/src/test-support/gateway-app-test-harness.ts:92`, a plain `app.close()`) then hangs — Node's `http.Server.close()` does not force-close existing keep-alive connections, it waits for them to end — past the spec's own 60s `afterAll` timeout, and Vitest reports its own `Hook timed out in 60000ms` as a **second, separate failure** (`Failed Suites 1` at `[1/2]`) alongside the real one (`Failed Tests 1` at `[2/2]`). This is the exact "two reports" symptom Round 1's F5 named, surviving via a hang instead of a throw — the `try`/`catch`-per-step fix only guards against a step that *rejects*, not one that never settles.

**Why this does not block approval:** (1) the real failure message is still fully present and legible in the output (`[2/2]`), not buried — the defect is duplication, not concealment; (2) no resource leak results — Testcontainers' own reaper plus `projector.stop()` (the first, unaffected step in the loop) both ran cleanly in every probe I made, confirmed by `docker ps -a` showing zero orphaned containers and `ps aux` showing zero orphaned child processes after every armed run; (3) it matches Round 1's own severity classification for this exact defect class (Minor); (4) it is orthogonal to the feature's two acceptance criteria — neither the reconnect-without-duplicates nor the heartbeat guarantee is affected. **Recommended follow-up** (not required before approval): wrap the `it` body's SSE connection lifecycle in `try/finally` so `req.destroy()` always runs, or race each `afterAll` step against its own short timeout. Route as a `test_maintainer` pass or fold into whichever feature next touches this spec (a natural candidate is `saga_e2e_verification`, 28, which will spawn more real child-process services and will hit the identical shape).

## Also confirmed

- **Scope.** `apps/gateway/**` and `progress/**` only, from this feature's own diff; `apps/projector` byte-untouched in the working tree throughout, including immediately after my own build-guard probe. `feature_list.json`/`http/*`/`specs/shared/test-matrix.md`/`progress/current.md` carry only leader-authored changes (F2/F6/F7 routing already closed, features 40/41 added, `http/gateway.http` — none of it this feature's business, none of it touched here).
- **Acceptance criterion 1** ("resumes without duplicates") — proven as the replay-boundary exclusivity claim (`slice(index + 1)`, never `slice(index)`), over the real HTTP/SSE wire, with the real `Last-Event-ID` round trip. Correctly not read as transport-level exactly-once, which `openapi.yaml` itself disclaims.
- **Acceptance criterion 2** ("heartbeat keeps the connection alive") — proven only as emission-on-schedule (F7's pre-existing test); the stronger "prevents an idle-timeout intermediary from closing the connection" reading is honestly left unproven, as Round 1 accepted. Nothing here overclaims either criterion.

## CHECKPOINTS.md — boxes walked this round

- [x] C1 — harness files present; `./init.sh` not re-run (implementer reports 0, unchanged by this feature).
- [x] C2 — exactly one feature `in_progress` before this review (id 26); flipped to `done` by this approval. `progress/current.md` correctly now describes feature 26 (Round 1's C2 leftover finding about feature 25 is resolved).
- [x] C3 — no forbidden domain import; no cross-service DB access (the E2E hands the spawned projector its own Mongo credentials via env, same as Round 1 confirmed); no shared runtime code beyond `shared-kernel`/`contracts` (the E2E crosses the projector boundary as a real OS process, now on the production boot path); Kafka carries the fact, NATS carries the signal, SSE carries the push.
- [x] C4 — lint + typecheck independently re-run and clean; domain tests remain pure; integration tests remain against real Testcontainers-backed brokers plus, now, a real production-built child process; no Jest.
- [x] C5 — no suspicious untracked files beyond what's accounted for above; `progress/history.md` effort record written below since verdict is APPROVED; `feature_list.json` reflects `done`; no commit made by me.
- [~] C6 — not applicable, `sdd: false`.
- [x] C7 — `specs/shared/` untouched by this feature (the `test-matrix.md` edit present in the working tree is the leader's F6 routing, already closed, and correctly attributed above); effort record completed below.

## `R55` → test mapping

Unchanged from Round 1's walk (both new tests independently re-verified this round via arming, above): `stream-projector-e2e.integration.spec.ts`'s single `it` for the projector→NATS→gateway seam, and `stream.integration.spec.ts`'s *"R55 'without duplicates'…"* for the replay-boundary exclusivity acceptance criterion.

## Findings summary, Round 2

| # | Severity | Status |
|---|---|---|
| F1 | Blocking (Round 1) | **Closed.** Verified independently: build-guard fires and stops the test before it can run against a stale/absent artefact; boot path now matches production; re-armed seam mutation reproduces Round 1's exact failure signature. |
| F2 | Material | Not this feature's; leader's to route (untouched this round; still open). |
| F3 | Minor | **Closed.** Retry-on-terminal-evidence with explicit `resumed: true` assertion, verified by re-arming; mutation now dies strictly after the retry loop's own assertion passes. |
| F4 | Minor | **Closed.** WeakMap-keyed shared state verified by reading and by two consecutive clean runs. |
| F5 | Minor | **Substantially improved, one residual gap named (new, Minor, not blocking):** the per-step try/catch guards against a throwing teardown step but not a hanging one; a genuine `it` timeout (not just a forced throw) leaves an SSE connection open, which hangs `testApp.close()` past the hook timeout and produces a second, competing (but not burying) failure report. No resource leak. Recommended as a follow-up, not a re-review blocker. |
| F6, F7 | Informational | Not this feature's; already closed by the leader (confirmed via `progress/current.md` and `specs/shared/test-matrix.md`'s diffs, both correctly attributed). |

## What must change before re-review

Nothing — this feature is **APPROVED**. The residual F5 gap above is recorded as a named follow-up, not a blocker.
