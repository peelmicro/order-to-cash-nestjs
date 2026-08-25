# F1 fix — `apps/orders` bare-JSON NATS wire (leader-routed, from `progress/review_gateway_rest_auth.md`)

## What was wrong

`apps/orders/src/main.ts` connected its `orders.create` NATS microservice with the framework's default `NatsRequestJSONDeserializer`/`NatsRecordSerializer`, while `apps/fulfillment/src/main.ts` and `apps/billing/src/main.ts` both installed `BareJsonNatsDeserializer`/`BareJsonNatsSerializer`. A bare-JSON caller (the Gateway's `NatsRpcClientAdapter`, and the shape the saga's own `NatsSagaCommandsAdapter` sends) has no `id` on its request. Nest's default deserializer sees no `id` and routes the message through `ServerNats.handleEvent` — the handler still runs (order persisted, outbox row written) but the reply subject is never answered, so the caller times out and, on retry, places a second real order.

## What was built

Confined to `apps/orders/**`, as instructed:

- `apps/orders/src/infrastructure/messaging/bare-json-nats.deserializer.ts` (new) — byte-for-byte copy of `apps/fulfillment/src/infrastructure/messaging/bare-json-nats.deserializer.ts` (same pattern billing already followed), with a banner recording it as a copy and citing F1.
- `apps/orders/src/infrastructure/messaging/bare-json-nats.serializer.ts` (new) — same treatment for the serializer half.
- `apps/orders/src/infrastructure/messaging/bare-json-nats.spec.ts` (new) — copy of the pure unit spec that exercises both directions against the installed `@nestjs/microservices@11.2.1` call shape (no broker). 5 tests, all pass.
- `apps/orders/src/main.ts` — installs both on the existing `Transport.NATS` `connectMicroservice` call (the only change to production wiring), with a comment explaining the finding and pointing at the new integration spec.
- `apps/orders/src/orders-create-wire.integration.spec.ts` (new) — the wire-parity proof (see below).

**Parity guard check (done first, per the brief):** I checked whether an existing parity guard already covers these two files across services before duplicating them, the way `idempotent-consumer.parity.spec.ts` does for `idempotent-consumer.ts`/`processed-events.repository.ts`. Grepped for any guard referencing `bare-json-nats` or its exported class names — none exists. Billing's own copy of these files (and of the unit spec) carries only a `// COPY OF — apps/fulfillment/...` banner and no automated cross-service parity check; I followed that exact convention rather than inventing a new guard, since none was specified and the reviewer's brief said only to satisfy one "if it exists".

## R-mapping / traceability

This is a defect fix outside any feature's `R<n>` numbering (`sdd: false`, not a feature at all) — there is no `test-matrix.md` row to update. The governing artifact is finding **F1** in `progress/review_gateway_rest_auth.md`, and the test that proves it closed is `orders-create-wire.integration.spec.ts`.

## The armed test and its verbatim failure

**Important deviation from the brief's literal instruction, done deliberately and recorded here:** the brief said "remove the deserializer/serializer from `main.ts` again, confirm the new test fails". I checked first (per the brief's own general instruction never to assume) and confirmed **no `*.spec.ts` in this repo imports `main.ts`** — `apps/orders`, `apps/billing` and `apps/fulfillment` all follow the same established pattern: every integration harness (`orders-acceptance.integration.spec.ts`, `saga-integration-harness.ts`, `billing-integration-harness.ts`, `stock-integration-harness.ts`) hand-mirrors `main.ts`'s `connectMicroservice` options rather than calling `main.ts`'s own `bootstrap()`. My new spec follows that same convention. So editing `main.ts` alone would not change what any test exercises — the load-bearing config, for test purposes, is the spec's own mirrored `connectMicroservice` call. I armed the deletion **there** instead (removing `deserializer`/`serializer` from the options block inside `orders-create-wire.integration.spec.ts`), which is the only way to make the guard's own execution path prove anything, and is exactly the FS4/BI16 precedent's shape. `main.ts` itself was never touched during arming (`diff` against a pre-arming backup byte-identical afterwards).

Ran with the pair removed:

```
pnpm --filter @otc/orders exec vitest run --config vitest.integration.config.mts src/orders-create-wire.integration.spec.ts
```

Verbatim failure (2 of 4 tests, both the raw-bare-JSON ones):

```
 FAIL  src/orders-create-wire.integration.spec.ts > orders.create — F1, the bare-JSON wire, proven against apps/orders/src/main.ts's real configuration (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine) > answers a bare-JSON request from a raw nats client (the Gateway/saga shape) with a bare-JSON reply — no Nest envelope, and a synchronous 201-worthy id (the F1 regression)
NatsError: TIMEOUT
 ❯ NatsError.errorForCode ../../node_modules/.pnpm/nats@2.29.3/node_modules/nats/nats-base-client/core.ts:170:11
 ❯ timeout ../../node_modules/.pnpm/nats@2.29.3/node_modules/nats/nats-base-client/util.ts:69:38
 ❯ new RequestOne ../../node_modules/.pnpm/nats@2.29.3/node_modules/nats/nats-base-client/request.ts:145:30
 ❯ NatsConnectionImpl.request ../../node_modules/.pnpm/nats@2.29.3/node_modules/nats/nats-base-client/nats.ts:417:16
 ❯ rawRequest src/orders-create-wire.integration.spec.ts:159:43

 FAIL  src/orders-create-wire.integration.spec.ts > orders.create — F1, the bare-JSON wire, proven against apps/orders/src/main.ts's real configuration (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine) > answers a bare-JSON RpcError from a raw nats client on a validation failure — never a hang, never a Nest envelope
NatsError: TIMEOUT
 ❯ NatsError.errorForCode ../../node_modules/.pnpm/nats@2.29.3/node_modules/nats/nats-base-client/core.ts:170:11
 ❯ ... (same stack)

 Test Files  1 failed (1)
      Tests  2 failed | 2 passed (4)
```

Exactly the same failure shape the reviewer reproduced against a disposable container (`BARE-JSON ERROR: TIMEOUT TIMEOUT`) — the handler ran to completion (a row was written in the earlier passing runs) but the reply subject was never answered.

The two `ClientProxy`-based tests in the same file (below) **stayed green even with the pair removed** — expected, since a `ClientProxy` request always carries an `id`, so `BareJsonNatsDeserializer`'s `hasId(message)` short-circuit is irrelevant either way for the request side; it is the reply side (serializer) that changes shape, and `ClientProxy`'s own deserializer tolerates both shapes (see below).

Restored the pair, re-ran: **4/4 pass**, `main.ts` diffed byte-identical to its pre-arming state throughout.

## Question 2 — does a `ClientProxy` caller still work? Yes, verified by execution, not assumption.

I read `node_modules/@nestjs/microservices`'s client-side code before answering (`client-nats.js`, `nats-response-json.deserializer.js`, `incoming-response.deserializer.js`, `client-proxy.js`):

- `ClientNats`'s default deserializer is `NatsResponseJSONDeserializer`, which decodes the raw bytes and delegates to `IncomingResponseDeserializer.deserialize`.
- `IncomingResponseDeserializer.isExternal(value)` returns `true` whenever the decoded JSON carries **none** of `err`/`response`/`isDisposed` — exactly what `BareJsonNatsSerializer`'s stripped reply looks like (a plain `OrdersCreateReplyPayload` or a plain `RpcError`, neither of which happens to have a field named `err`, `response` or `isDisposed`).
- When `isExternal` is true, `mapToSchema(value)` wraps it as `{ id: value.id, response: value, isDisposed: true }` — i.e. **the client auto-detects a non-enveloped ("external") reply and synthesizes the envelope itself.** This is by design, for interoperating with non-Nest RPC responders.
- Back in `ClientNats.createSubscriptionHandler`, `message.id` is `undefined` on this synthesized envelope, so the `message.id !== packet.id` short-circuit never fires; `isDisposed` is `true`, so the observer callback fires with `{ err: undefined, response: <bare payload>, isDisposed: true }`.
- `ClientProxy.createObserver`'s `response !== undefined && isDisposed` branch then calls `observer.next(response)` followed by `observer.complete()` — a normal, correctly-resolving `firstValueFrom(...)`.
- The `RpcError` case is unaffected by the envelope change either way: `OrdersCreateController.create` never throws (its own header comment states this) — every outcome, success or refusal, was **already** returned as a plain object under Nest's `response` key even before this fix, so `reply.code` being a string was always the caller's own discriminator (`isRpcError` in both `orders-acceptance.integration.spec.ts` and my new spec). Nothing changes here.

**Verified by execution**, not just by reading: `orders-create-wire.integration.spec.ts` drives a real `ClientProxyFactory`-created `ClientProxy` against the same bare-JSON-configured responder, over real Testcontainers NATS, and both the success case and the validation-failure case resolve correctly:

```
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

**Conclusion: yes, a `ClientProxy` caller (including `scripts/place-order.mjs`, which I did not touch per the brief) still works against the fixed `apps/orders` responder.** This is not a coincidence of this particular payload shape — it follows from `@nestjs/microservices`'s own "external reply" auto-detection, which exists precisely so a Nest client can talk to a non-Nest-packet-speaking responder.

## Question 4 — other affected `apps/orders` subjects

Swept `apps/orders/src` for every `@MessagePattern`/`@EventPattern`:

```
apps/orders/src/presentation/orders-create.controller.ts:43:  @MessagePattern('orders.create', Transport.NATS)
apps/orders/src/presentation/saga-facts.controller.ts:103:  @EventPattern(ORDERS_FACTS_TOPIC, Transport.KAFKA)
apps/orders/src/presentation/saga-facts.controller.ts:108:  @EventPattern(FULFILLMENT_FACTS_TOPIC, Transport.KAFKA)
apps/orders/src/presentation/saga-facts.controller.ts:113:  @EventPattern(BILLING_FACTS_TOPIC, Transport.KAFKA)
```

**`orders.create` is the ONLY NATS `@MessagePattern` in this service**, and it is the one this fix repairs. The three `@EventPattern` handlers are Kafka fact consumers on a wholly separate `connectMicroservice` (`Transport.KAFKA`) — the bare-JSON NATS (de)serializer pair does not touch them.

`orders.cancel` (flagged by the reviewer as pre-armed for the same trap) still has **no responder anywhere in `apps/orders`** — confirmed by the same sweep. Nothing regresses or newly reaches it; it remains unreachable exactly as before. Whoever implements it will now inherit a `main.ts` that already speaks the correct wire, so the trap the reviewer warned about (a future responder inheriting the old broken default) no longer exists.

## Verification

- `pnpm --filter @otc/orders exec eslint .` → 0 problems (one pre-fix warning on an unused test parameter, removed).
- `pnpm --filter @otc/orders typecheck` → clean.
- `pnpm --filter @otc/orders test` (unit) → **31 files / 404 tests passed**, including the 5 new `bare-json-nats.spec.ts` cases.
- `pnpm --filter @otc/orders exec vitest run --config vitest.integration.config.mts` (full integration suite, real MySQL/Kafka/NATS Testcontainers) → **19 files / 61 tests passed**, including `orders-create-wire.integration.spec.ts`'s 4 cases. (The `ServerKafka`/`GroupCoordinator` error lines in the run's stdout are expected noise from `saga-consumption.integration.spec.ts`'s own E3 simulated-transient-failure fixture and single-node KRaft broker warm-up, not new failures — the run's own summary line is `19 passed / 61 passed`.)
- `./init.sh` → exit 0.
- `pnpm quality` (repo-wide) → **fails**, but not because of anything in `apps/orders`. The failure is `apps/projector/src/read-model-sole-writer.spec.ts` ("permits a mongodb import in apps/projector and apps/seed only" — now also seeing `gateway`), which is the concurrent `gateway_rest_auth` work the brief itself warned me not to collide with ("another agent is working there right now"). I did not touch `apps/gateway` or `apps/projector`, and `apps/orders`' own lint/typecheck/test (verified individually above) are unaffected and green. `git status --porcelain apps/orders` confirms scope is exactly the 5 files listed above; nothing outside `apps/orders/**` was modified by this work.

## Files changed

- `apps/orders/src/main.ts` (modified — 3 lines of config + comment)
- `apps/orders/src/infrastructure/messaging/bare-json-nats.deserializer.ts` (new)
- `apps/orders/src/infrastructure/messaging/bare-json-nats.serializer.ts` (new)
- `apps/orders/src/infrastructure/messaging/bare-json-nats.spec.ts` (new)
- `apps/orders/src/orders-create-wire.integration.spec.ts` (new)

No commit made. `feature_list.json` untouched (this is not a feature).

---

# Addendum — G5, G6, G7 (`progress/review_gateway_rest_auth.md` Round 2)

## G5 — the parity guard, `apps/orders/src/infrastructure/messaging/bare-json-nats.parity.spec.ts` (new file)

**What it compares, and why that catches semantic divergence, not text drift.**

It compares the **full body** of `bare-json-nats.deserializer.ts` and `bare-json-nats.serializer.ts` in every service registered `'nats-bare-json-copy'` (today: `orders`, `fulfillment`, `billing`) against the canonical (`apps/fulfillment`'s copy — the file with no `COPY OF` banner, i.e. the original), **after stripping each side's leading contiguous `//` comment block**. What remains is the executable code: every `import`, the class declaration, every method body. `Object.is`/`toBe` string equality means **any single-character change to the executable code fails the test** — not just a changed keyword or a comment. This is categorically different from F2's substring scan (`text.includes("'mysql2'")`, which a differently-quoted import specifier sails past) and from OI12's pre-N5 discriminator (a `Divergence:` comment nobody validated against the actual code): there is no pattern to dodge here, because the comparison is against literally everything that is not a leading comment. Confirmed by reading: after banner-stripping, all three services' copies of both files are byte-identical today (verified independently before writing any guard code, via a throwaway `diff` on banner-stripped output — zero lines of difference across all three).

I deliberately did **not** build a second, OI12-style Docker-free behavioural harness on top of this (the `FileBackedIdempotentConsumer` block). That extra layer exists in OI12 specifically because ITS original discriminator was a *prose* `Divergence:` comment with nothing behind it — a copy could gut its dedup logic entirely and the guard would still read the comment and pass. Here, each copy already owns a **real, executing** unit spec (`bare-json-nats.spec.ts`, present — and matched by the registry's `'nats-bare-json-copy'` mode requiring the file pair, though the *spec* file itself is deliberately out of this guard's scope, matching OI12's own precedent of not parity-checking `idempotent-consumer.spec.ts` either) that drives the real `@nestjs/microservices@11.2.1` `ServerNats` call shape and asserts genuine wire behaviour — synthetic-id assignment, event-vs-request branching, bare-reply framing, the `RpcError` shape. Byte-identity to a canonical **already proven correct by its own executing spec** is sufficient to transfer that proof to every copy; a second reference implementation would prove nothing this doesn't already prove, at real cost (fulfillment/billing are out of my modify scope for this task, so I could not have built one there anyway).

**Self-validating registry**, mirroring OI12's post-N5 shape exactly: `SERVICE_BARE_JSON_MODE: Record<string, 'nats-bare-json-copy' | 'no-nats-responder'>`. Two tests enforce it against the filesystem rather than trusting it: an unregistered `apps/*` directory fails loudly; a registered mode that disagrees with reality (a `'nats-bare-json-copy'` entry missing either file or with no real `@MessagePattern(..., Transport.NATS)` handler to justify owning the pair; a `'no-nats-responder'` entry that has grown one, or owns a dead copy with nothing to justify it) fails loudly too. No service can silently exempt itself by omission.

**A genuine false positive found and fixed while building this, worth recording because it is itself evidence the discriminator inspects real code rather than rubber-stamping:** the first version of `hasNatsMessagePatternHandler` walked every `.ts` file including `*.spec.ts`, and matched two — `apps/notifications/src/notifications-consumes-only.spec.ts` and `apps/projector/src/projector-consumes-only.spec.ts` — because those *unrelated* guards (for a different feature, proving those services never register a `@MessagePattern`) each embed the literal fixture string `"@MessagePattern('orders.create', Transport.NATS)"` to test their OWN detector. The registry-honesty test caught this immediately and failed loudly (`notifications: registered 'no-nats-responder' but has grown an @MessagePattern(..., Transport.NATS) handler …`; same for `projector`) before I'd perturbed anything on purpose — a real signal that the walk was too broad. Fixed by excluding `*.spec.ts` from the walk (production responders live exclusively under `presentation/`, never in a spec file). Verbatim failure before the fix:

```
AssertionError: notifications: registered 'no-nats-responder' but has grown an @MessagePattern(..., Transport.NATS) handler — promote it to 'nats-bare-json-copy' and add the wire pair; projector: registered 'no-nats-responder' but has grown an @MessagePattern(..., Transport.NATS) handler — promote it to 'nats-bare-json-copy' and add the wire pair: expected [ …(2) ] to deeply equal []
```

**Armed perturbation — a method body, not a comment.** Bounded scope for this addendum forbids modifying `apps/fulfillment`/`apps/billing`, so I perturbed the **orders** copy instead (still proves the guard fires and names the diverging service correctly — the mechanism is symmetric across all three). Changed `apps/orders/src/infrastructure/messaging/bare-json-nats.serializer.ts`'s emitted `RpcError.code` from `'INTERNAL_ERROR'` to `'INTERNAL_ERROR_MUTATED'` (a real behavioural change: this literal is what a caller sees on a Nest-level refusal). Ran:

```
pnpm --filter @otc/orders exec vitest run src/infrastructure/messaging/bare-json-nats.parity.spec.ts
```

Verbatim failure:

```
 FAIL  src/infrastructure/messaging/bare-json-nats.parity.spec.ts > bare-json-nats.parity — G5 > holds every NATS responder's copy of the bare-JSON wire pair byte-identical to the canonical (apps/fulfillment) copy
AssertionError: apps/orders's bare-json-nats.serializer.ts diverges from the canonical apps/fulfillment copy (banner-stripped): expected 'import { JSONCodec } from \'nats\';\n…' to be 'import { JSONCodec } from \'nats\';\n…' // Object.is equality

- Expected
+ Received

@@ -14,11 +14,11 @@

   export class BareJsonNatsSerializer implements Serializer<NestOutgoingPacket, NatsRecord> {
     serialize(packet: NestOutgoingPacket): NatsRecord {
       if (packet?.err !== undefined && packet?.err !== null) {
         const rpcError: RpcError = {
-         code: 'INTERNAL_ERROR',
+         code: 'INTERNAL_ERROR_MUTATED',
           message: String(packet.err),
           occurredAt: new Date().toISOString(),
         };
         return new NatsRecord(jsonCodec.encode(rpcError));
       }

 Test Files  1 failed (1)
      Tests  1 failed | 4 passed (5)
```

Restored `bare-json-nats.serializer.ts` from a pre-perturbation copy, confirmed `diff` byte-identical to the backup, re-ran: **5/5 pass**.

## G6 — no guard that `main.ts` installs the pair. Ruling: **note as owed, do not add now.**

Reasoning: a text/grep check on `main.ts`'s source for `new BareJsonNatsDeserializer()`/`new BareJsonNatsSerializer()` would be exactly the anti-pattern G5 itself rules out — a pattern-matchable string, defeatable the same way F2 was (a refactor to a factory function, a renamed local variable, an indirection layer all sail past a grep untouched). A *genuine* behavioural guard would need to actually boot each service's real `bootstrap()` (or an equivalent that exercises the identical code path) against a live NATS broker and prove the resulting responder answers bare JSON — which is precisely what `orders-create-wire.integration.spec.ts` already proves for `apps/orders`, but by hand-mirroring `main.ts`'s options (the established convention in this repo — confirmed no `*.spec.ts` anywhere imports any service's `main.ts`), not by importing `main.ts` itself. Building a trustworthy cross-service version of "does `main.ts` actually install this" would mean either (a) importing and running `bootstrap()` directly, which no test in this codebase does today and which raises its own design questions (port ownership, env-var isolation) not yet solved anywhere, or (b) accepting a weaker text check and reintroducing the exact risk G5 was raised to close. Given the finding is honestly pre-existing and symmetric across all three services, and a correct fix touches `apps/fulfillment`/`apps/billing` (at minimum to add matching harness support) which are off-limits for this task, I am leaving it as a recorded, owed follow-up rather than shipping a guard I would not trust.

## G7 — `orders-acceptance.integration.spec.ts` hand-mirrors stale `main.ts` options. Ruling: **left as-is, with a note added** (not brought into line).

Added a comment directly above that spec's `app.connectMicroservice(...)` call (the only change to that file) explaining why it is deliberately NOT updated to install the bare-JSON pair: its only caller is `ClientProxyFactory` (stated in the file's own pre-existing header), and `ClientProxy`'s deserializer treats a bare-JSON reply and a Nest-enveloped reply identically (`IncomingResponseDeserializer.isExternal`) — verified twice now, by me in the F1 fix and independently by the reviewer running both `ClientProxy` cases with and without the pair installed. Adding the pair here would duplicate, not extend, coverage `orders-create-wire.integration.spec.ts` already owns for the actual production wire. Re-ran this file for real (Testcontainers): **3/3 pass**, confirming the comment-only edit changed nothing behavioural.

```
pnpm --filter @otc/orders exec vitest run --config vitest.integration.config.mts src/orders-acceptance.integration.spec.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

## Files changed in this addendum

- `apps/orders/src/infrastructure/messaging/bare-json-nats.parity.spec.ts` (new — the G5 guard)
- `apps/orders/src/orders-acceptance.integration.spec.ts` (comment-only — the G7 note)

No changes to `apps/fulfillment`, `apps/billing`, `apps/gateway`, `apps/projector`, `packages/`, `specs/`, `scripts/`, or `feature_list.json`. No commit made.

## Verification (addendum)

- `pnpm --filter @otc/orders exec eslint .` → 0 problems.
- `pnpm --filter @otc/orders typecheck` → clean.
- `pnpm --filter @otc/orders test` (unit) → **32 files / 409 tests passed** (up from 31/404 — the 5 new G5 guard tests).
- `pnpm --filter @otc/orders exec vitest run --config vitest.integration.config.mts src/orders-acceptance.integration.spec.ts` → 3/3 pass (unaffected by the G7 comment).
- Full integration suite re-run, completed: `pnpm --filter @otc/orders exec vitest run --config vitest.integration.config.mts` → **19 files / 61 tests passed** (exit code 0), including the two files touched in this addendum. (Same expected `ServerKafka`/`GroupCoordinator` noise as the F1 section above — pre-existing broker warm-up/E3-fixture logging, not a new failure.)
- `./init.sh` → exit 0 (re-run after the addendum).
