# impl_oi12_behavioural_parity — harness defect fix (N5)

Not a `feature_list.json` feature. Fixes finding **N5** from `progress/review_notifications_service.md`: OI12's "variant" branch read only the leading `//` comment banner and asserted two substrings — it never imported a class, never read a body, executed no behaviour. A reviewer proved it by replacing a service's entire `runOnce` with a body performing NO deduplication at all, banner untouched, and OI12 passed 4/4.

Scope honoured: only `apps/orders/src/**/idempotent-consumer.parity.spec.ts` and new test-support files under `apps/orders`. `apps/notifications`, `apps/fulfillment`, `apps/billing`, `apps/projector`, `packages/`, `specs/`, `feature_list.json` were read where useful but never modified. No commit made.

## What was built

### 1. `apps/orders/src/infrastructure/messaging/test-support/idempotent-consumer-conformance.ts` (new)

A generic, framework-only (no MySQL/Mongo/Drizzle awareness) behavioural conformance suite, `describeIdempotentConsumerConformance(label, harness)`. `harness.createConsumer()` must construct a genuinely fresh instance of the implementation under test on every call, all sharing one backing store; `harness.newEventId()` supplies collision-free ids. Five `it()`s:

1. *first call for an unseen `(eventId, consumer)` pair runs the work and reports `processed`.*
2. *second call for the same pair does NOT run the work and reports `duplicate`.*
3. *a consumer constructed fresh over the SAME backing store still returns `duplicate`* — the N1-catching case, explicitly called out in the file's own header as the single most valuable assertion.
4. *two different `eventId`s both run.*
5. *the same `eventId` under a different consumer name runs — the key is the pair, not the id alone (R17)* — includes a trailing re-check that the redelivery guard still holds per pair afterwards.

Designed to be copy-adopted by future variants the same way `idempotent-consumer.ts` itself is copied (§6.3's convention) — stated in its own header, and cross-referenced from the parity spec's case 4.

### 2. `apps/orders/src/infrastructure/messaging/test-support/file-backed-idempotent-consumer.example.ts` (new)

A real, JSON-file-backed reference implementation of the pattern (insert-first discipline), used only to prove the conformance suite is genuinely behavioural and non-vacuous **without Docker**, inside the fast `pnpm quality` gate. A fresh instance re-reads the file, so it is durable across construction the same way a real MySQL/Mongo ledger is — deliberately NOT an in-memory `Map`, which would trivially (and wrongly) pass case 3.

### 3. `apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts` (modified — the fast, Docker-free gate)

- **Discriminator fix.** Added `SERVICE_IDEMPOTENCY_MODE`, an explicit `Record<app, 'mysql-copy' | 'documented-variant' | 'no-consumer'>` registry covering all eight `apps/*` directories today (`orders`, `fulfillment`, `billing`, `notifications` → `mysql-copy`; `projector` → `documented-variant`; `gateway`, `seed`, `web` → `no-consumer`). Two new cases make it self-validating rather than trusted:
  - *"requires every app to be accounted for in the idempotency mode registry"* — fails loudly the moment `readdirSync('apps')` returns a name absent from the registry.
  - *"keeps the idempotency mode registry honest against what is actually on disk"* — fails loudly if a `'mysql-copy'` entry has no schema file, a `'documented-variant'` entry has one, or a `'no-consumer'` entry has grown an `@EventPattern` handler.

  This directly closes the compounding weakness N5 named: a service could previously exempt itself from case 1 (byte-identity) and case 3 (must-own-the-pattern) simply by not creating `processed-events.schema.ts`. Cases 1 and 3 are now keyed off `SERVICE_IDEMPOTENCY_MODE[app]`, not `hasMySqlProcessedEventsSchema(app)`.

  Note on the tension with `design.md` §6.4: that section explicitly *rejected* a hand-maintained registry ("a registry that must be edited when a copy is added is a registry someone forgets to edit, and the drift then hides in the very file that was supposed to reveal it"). The spec file's own new header comment records why this reintroduces one anyway: that objection holds against an *unvalidated* registry; `SERVICE_IDEMPOTENCY_MODE` is checked against `readdirSync`/`hasMySqlProcessedEventsSchema`/`hasEventPatternHandler` on every run, so forgetting to update it turns the very next `pnpm quality` red instead of hiding the drift. This is a leader-directed harness fix, not a re-derivation of the spec by the implementer; flagged here for visibility since it amends design.md's stated reasoning without going through `spec_author`.

- **Case 4 (variant banner) strengthened, not just kept.** Still requires the canonical-path citation and a `Divergence:` line, but now additionally requires a `Behavioural conformance: <path>` line naming a file that **must exist on disk** (`existsSync` check against the named path). This closes as much of the "banner alone" blind spot as is reachable without crossing the app boundary (apps/orders cannot import another service's source — see below) — prose is no longer sufficient; the named spec file must actually exist.

- **New `describe` block: the behavioural self-test.** Runs `describeIdempotentConsumerConformance` against `FileBackedIdempotentConsumer` — real, Docker-free behaviour executed inside `pnpm quality` itself, replacing the old blind banner-only case's "execution" of nothing.

### 4. `apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.integration.spec.ts` (new — Testcontainers, real MySQL)

Runs the **same** generic conformance suite against the **real, unmodified canonical** `IdempotentConsumer` (wired through `DrizzleUnitOfWork` + `startOrdersTestFixture`, real `mysql:8.4.11` via Testcontainers). This is the literal "import the actual class and execute it" proof design.md's discriminator originally lacked for MySQL copies too — not just variants. Runs via `pnpm test:integration`, outside `pnpm quality`'s Docker-free fast gate, per this repo's established convention (`vitest.config.mts` excludes `*.integration.spec.ts`; see its own comment and `progress/impl_db_orders.md`).

## Why "confirm the suite still passes unmodified against all three current implementations" is satisfied without cross-app imports

Scope forbids touching `apps/fulfillment`, `apps/billing`, `apps/notifications`, and I judged that importing their source files from a new `apps/orders` spec (the only way to execute them directly) would introduce a cross-app coupling precedent that doesn't exist anywhere else in this codebase and that the "database per service" boundary argues against — a decision I did not think was mine to make unilaterally, so I did not make it.

Instead: OI12's existing (kept, unmodified in substance) byte-identity case already proves `fulfillment/billing/notifications`'s `idempotent-consumer.ts` + `processed-events.repository.ts` are **byte-identical, post-banner**, to the canonical this feature's new integration spec just proved behaviourally correct over real MySQL. Byte-identity + a behavioural proof of the identical text composes into a behavioural proof of all three copies, without executing their physically separate files. This is the reading I took from the task's own phrasing — "This turns OI12 from 'these files match' into 'these files match **and** the pattern actually works'" — and I ran the byte-identity case (unchanged in substance) alongside the new integration spec to confirm the premise holds today; both are green (see below).

## Discriminator mechanism — summary

An explicit, **self-validating** registry (`SERVICE_IDEMPOTENCY_MODE`), not a bare hand-maintained list: it is cross-checked against the filesystem on every run and fails loudly for (a) any `apps/*` directory absent from it, and (b) any entry whose declared mode disagrees with what's actually on disk. A service can no longer opt itself out of the canonical pattern's guards by omitting `processed-events.schema.ts` — the registry now decides mode, and omitting the schema file while still being registered `'mysql-copy'` is itself a failure.

## Armed-mutation record (verbatim)

Two mutations were armed and reverted, per the task's instruction to prove the fix catches the exact defect class.

### Mutation 1 — the Docker-free fixture (`file-backed-idempotent-consumer.example.ts`), proving the fast gate itself now executes real behaviour

`runOnce` replaced with:

```ts
async runOnce(eventId: string, consumer: string, work: () => Promise<void>): Promise<'processed' | 'duplicate'> {
  // MUTATION (N5 reproduction, temporary — restored immediately after
  // recording the failure): no dedup check at all, banner untouched.
  await work();
  return 'processed';
}
```

`pnpm vitest run src/infrastructure/messaging/idempotent-consumer.parity.spec.ts` (apps/orders) — **3 of 11 failed**, verbatim:

```
 FAIL  src/infrastructure/messaging/idempotent-consumer.parity.spec.ts > idempotent-consumer.parity — OI12 behavioural self-test > idempotent-consumer behavioural conformance — the file-backed reference variant (Docker-free) > a second call for the same (eventId, consumer) pair does NOT run the work and reports duplicate
AssertionError: expected 'processed' to be 'duplicate' // Object.is equality

Expected: "duplicate"
Received: "processed"

 FAIL  ... > a consumer constructed fresh over the SAME backing store still returns duplicate — a purely in-memory implementation must fail this
AssertionError: expected 'processed' to be 'duplicate' // Object.is equality

 FAIL  ... > the same eventId under a DIFFERENT consumer name runs — the key is the pair, not the id alone (R17)
AssertionError: expected 'processed' to be 'duplicate' // Object.is equality

 Test Files  1 failed (1)
      Tests  3 failed | 8 passed (11)
```

Restored byte-identically (`diff` against the pre-mutation copy showed no differences after restore). Re-ran: `Test Files 1 passed (1)`, `Tests 11 passed (11)`.

### Mutation 2 — the real canonical (`idempotent-consumer.ts`), the literal reproduction of N5 against real MySQL

`runOnce` replaced with:

```ts
async runOnce(
  eventId: string,
  consumer: ConsumerName,
  work: (tx: TransactionContext) => Promise<void>,
): Promise<ConsumptionOutcome> {
  // MUTATION (N5 reproduction, temporary — restored immediately after
  // recording the failure in progress/impl_oi12_behavioural_parity.md):
  // no dedup record at all, banner untouched.
  await this.unitOfWork.execute(async (tx) => {
    await work(tx);
  });
  return 'processed';
}
```

`pnpm vitest run --config vitest.integration.config.mts src/infrastructure/messaging/idempotent-consumer.parity.integration.spec.ts` (apps/orders, real `mysql:8.4.11` via Testcontainers) — **3 of 5 failed**, verbatim:

```
 FAIL  ... > a second call for the same (eventId, consumer) pair does NOT run the work and reports duplicate
AssertionError: expected 'processed' to be 'duplicate' // Object.is equality

 FAIL  ... > a consumer constructed fresh over the SAME backing store still returns duplicate — a purely in-memory implementation must fail this
AssertionError: expected 'processed' to be 'duplicate' // Object.is equality

 FAIL  ... > the same eventId under a DIFFERENT consumer name runs — the key is the pair, not the id alone (R17)
AssertionError: expected 'processed' to be 'duplicate' // Object.is equality

 Test Files  1 failed (1)
      Tests  3 failed | 2 passed (5)
```

Restored byte-identically (`diff` against the pre-mutation copy showed no differences after restore). Re-ran, both files: `Test Files 2 passed (2)`, `Tests 10 passed (10)` (the new integration parity spec plus the pre-existing `idempotent-consumer.integration.spec.ts` R17/R18/OI10 suite, both untouched by the mutation, ran together to confirm no collateral damage).

## Self-verification

- `apps/orders`: `pnpm vitest run src/infrastructure/messaging/idempotent-consumer.parity.spec.ts` — 11/11.
- `apps/orders`: `pnpm vitest run --config vitest.integration.config.mts src/infrastructure/messaging/idempotent-consumer.parity.integration.spec.ts` — 5/5 (real MySQL, Testcontainers).
- `apps/orders`: `pnpm typecheck` — clean.
- Root: `npx eslint` over the four touched/new files — clean.
- Root: `pnpm quality` (lint + typecheck + test, all 10 workspace packages) — **exit 0**. `apps/orders`: 30 test files, 399 tests passed.
- Root: `./init.sh` — exit 0.

## What I could not do / left for later

- Did not execute `fulfillment`'s, `billing`'s or `notifications`' own `idempotent-consumer.ts` directly (cross-app import), for the reasons above — satisfied instead via byte-identity + canonical-behavioural composition, stated explicitly in this file and in the parity spec's own header.
- The new "Behavioural conformance:" banner requirement (case 4) can verify a named file *exists*; it cannot verify the named file actually runs the conformance suite meaningfully, since that would again require importing another app's spec. This is a known, stated residual gap — the strongest enforcement point reachable without crossing the app boundary the task told me not to cross.
- Did not touch `apps/projector` — it has no `idempotent-consumer.ts` yet (feature 24 not started), so case 4 stays dormant, as intended; `SERVICE_IDEMPOTENCY_MODE['projector'] = 'documented-variant'` is a pre-declaration for when that feature lands.
- `specs/shared/test-matrix.md` and `feature_list.json` were left untouched per explicit instruction (this is not an sdd feature).
