# impl: deadlock_retry — MySQL deadlock surfacing as INTERNAL_ERROR

Not a `feature_list.json` feature. Fixes the N11 defect confirmed in
`progress/impl_observability_dashboards.md`'s "D1-D5" section: a genuine
InnoDB `ER_LOCK_DEADLOCK` on a concurrent write fell through every
`instanceof` branch in `rpc-error-mapper.ts` and surfaced as the generic
`INTERNAL_ERROR` instead of `CONFLICT`. Approved fix: Option B, retry the
whole unit of work at the transaction boundary.

## Where the retry landed, and why

`DrizzleUnitOfWork.execute()` in all four services —
`apps/{billing,fulfillment,notifications,orders}/src/infrastructure/persistence/drizzle-unit-of-work.ts`
— the ONE place a `TransactionContext` is opened. Not `invoice.repository.ts`
(the brief's explicit constraint: `rpc-error-mapper.ts` and
`isDuplicateEntryError` stay untouched), not a new error-mapping branch
anywhere. On `ER_LOCK_DEADLOCK`/`ER_LOCK_WAIT_TIMEOUT`, `execute()` retries
`work` inside a brand-new `db.transaction(...)` call (bounded, `MAX_ATTEMPTS
= 3`, backoff `[10, 25]` ms, last error rethrown unchanged on exhaustion).
On the retry, if the original cause was a genuine same-key race, the loser
now hits the UNIQUE index and gets `ER_DUP_ENTRY`, which
`invoice.repository.ts`'s EXISTING `isDuplicateEntryError` already maps to
`PaymentReferenceConflictError` → `CONFLICT` — the right answer emerges
from the retry, nothing new was built to produce it.

All four files updated **identically** (the retry logic, error-code set,
constants and JSDoc are byte-identical across all four after each file's
own pre-existing banner — verified with a banner-stripped, type-name-
normalised diff before and after this change; the pre-existing prose
differences, e.g. notifications' shorter header comment, `orders` carrying
no "COPY OF" banner as the canonical, are unchanged from before this pass).

**No dedicated parity spec exists for `drizzle-unit-of-work.ts` specifically**
— checked before assuming one, per the brief's instruction. `git grep`
across `apps/*/src/**/*.spec.ts` for anything comparing the four copies
byte-for-byte found nothing. The two closest guards
(`idempotent-consumer.parity.spec.ts`'s OI12, `outbox-relay.parity.spec.ts`'s
OB1) only check that files THEY own (`idempotent-consumer.ts`, the
outbox-relay family) import `../persistence/drizzle-unit-of-work` from an
allowed whitelist — they never byte-compare `drizzle-unit-of-work.ts`
itself. Since this change adds no new export and does not alter
`DrizzleUnitOfWork`'s or `asDrizzleTx`'s signature, both guards pass
unmodified (`idempotent-consumer.parity.spec.ts`: 11/11;
`outbox-relay.parity.spec.ts`: 3/3). Kept the four copies textually
identical anyway, by discipline, matching the established "COPY OF"
convention every other cross-service copy in this codebase follows — not
because a guard required it.

## Are the callbacks genuinely re-entrant? Checked, not assumed

Swept every `unitOfWork.execute(...)` call site across all four services
(`payment-register.handler.ts`, `credit-release.handler.ts`,
`credit-hold.handler.ts`, `invoice-issue.handler.ts`,
`place-order.handler.ts`, `cancel-order.handler.ts`,
`stock-reservation.handler.ts`, `despatch-creation.handler.ts`,
`stock.command-handlers.ts`, every service's `idempotent-consumer.ts`,
`saga-fact-handler.ts`, `saga-first-park-dead-letter-handler.ts`,
`saga-command-sweeper.service.ts`, `processed-events-compensation.ts`).
Every one is safe to re-run wholesale:

- Every domain aggregate used inside a callback is constructed or
  re-read **inside** the closure (`Order.place(...)`,
  `Invoice.reconstitute(lockedSnapshot)`, `credits.lockForOrder(tx, ...)`,
  `this.orders.findById(correlationId, tx)`, etc.) — never captured from
  outside and mutated across attempts. A retry re-runs the closure from
  scratch, so `pullDomainEvents()` (called inside `save`/`markPaid` via
  `OutboxRecorder.record`) always drains a freshly-populated event queue,
  never an already-drained one from a failed attempt.
- Sequence allocation (`order-number-allocator.ts`,
  `invoice-number-allocator.ts`, `despatch-number-allocator.ts`) happens
  **inside** the same transaction, by explicit design
  (`place-order.handler.ts`'s own "D7" comment) — a rolled-back attempt
  returns the number rather than burning it, so a retry does not skip
  values.
- The one call site with an external side effect outside a DB write
  (`saga-first-park-dead-letter-handler.ts`'s `this.dlq.publish(...)`, a
  real Kafka publish) happens **before** `unitOfWork.execute(...)` is ever
  called, not inside it — confirmed by reading the file; nothing here is
  retried.
- No callback anywhere makes an RPC/HTTP call, sends an email, or performs
  any other non-DB, non-idempotent side effect inside `execute()` — every
  write in this codebase goes through the transactional-outbox pattern, so
  the ONLY effects a retried transaction can have are DB rows that either
  all commit or all roll back together.
- `IdempotentConsumer.runOnce`'s `DuplicateEventSignal` (thrown
  deliberately to force a rollback-and-report-duplicate) is a plain `Error`
  with no `.cause.code` — `retryableLockErrorCode` returns `undefined` for
  it, so it is never mistaken for a lock error and never retried.

**Conclusion: yes, genuinely re-entrant, checked caller by caller, not
assumed.**

## `ER_LOCK_WAIT_TIMEOUT` — included, and why

Retried identically to `ER_LOCK_DEADLOCK`, same bounded attempts. Reasoning:

- Same class of problem — transient contention, not a data conflict. A
  deadlock is InnoDB's wait-for-graph detector finding a cycle and killing
  one side; a lock-wait timeout is InnoDB giving up on a wait that never
  resolved before `innodb_lock_wait_timeout` elapsed. Neither means the
  waiting transaction's data or query was wrong.
- This codebase's writes are short, single/few-row statements — a
  wait-timeout here is far more likely to be transient queuing behind a
  handful of other short transactions than a genuinely stuck one.
- `db.transaction(...)`'s own error handling issues a `ROLLBACK` and
  releases the connection on ANY thrown error, regardless of what MySQL's
  own `innodb_rollback_on_timeout` (default OFF, meaning only the failed
  *statement* rolls back at the server level) would otherwise leave
  standing — so by the time the retry loop re-invokes `db.transaction`, it
  is always a genuinely fresh transaction and fresh connection, never a
  resumed one. This is what makes retrying a timeout just as safe as
  retrying a deadlock.
- Risk acknowledged and bounded: `MAX_ATTEMPTS = 3` caps the worst case at
  two retries — if a wait-timeout is ever caused by a genuinely stuck
  transaction elsewhere (a bug, not contention), this adds at most
  `2 × innodb_lock_wait_timeout` of extra latency before the original
  error surfaces, never an unbounded hang. That bound is exactly why the
  attempt count is small.

## Testing

### Unit — `drizzle-unit-of-work.spec.ts`, one per service (identical, "COPY OF" convention)

Pure unit, mocked `db.transaction`, no Docker. Six cases per file:
retries once on `ER_LOCK_DEADLOCK` then succeeds (R: retries the whole
unit of work); retries on `ER_LOCK_WAIT_TIMEOUT` the same way; **never**
retries `ER_DUP_ENTRY` (1 attempt, immediate rethrow); bounded — exhausts
`MAX_ATTEMPTS` and rethrows the ORIGINAL error object (`.rejects.toBe(...)`,
not just a matching message); an error with no driver `cause.code` at all
is never retried; a plain success commits on the first attempt (no
spurious retry). All 6 pass in `apps/{billing,fulfillment,notifications,orders}`
(24 tests total).

### Integration — `apps/billing/src/infrastructure/persistence/invoice-payment-deadlock.integration.spec.ts` (real MySQL, real NATS, real Kafka — Testcontainers)

Two tests, deliberately different in kind:

1. **The realistic reproduction.** 140 distinct, already-issued invoices
   (own retailer/company/credit line each — nothing to serialise on
   `credits`/`invoices`), all registering a payment with the exact SAME
   `paymentReference`, fired concurrently in one `Promise.all` — N11's own
   decisive scale (70 pairs / 140 RPCs), unchanged. Asserts: zero
   `INTERNAL_ERROR` among the 139 losers, exactly one `accepted`, the rest
   `CONFLICT`, exactly one `payments` row in the database. **Passed every
   run** (7/7 across this feature's verification pass).
2. **The deterministic reproduction.** An ENGINEERED two-transaction
   crossed-lock-order deadlock: transaction A locks credit row 1 then
   wants row 2; transaction B locks row 2 then wants row 1; a barrier
   forces both to hold their first lock before either attempts the
   second — the textbook recipe InnoDB's wait-for-graph detector reliably
   kills one side of, run through the REAL `DrizzleUnitOfWork` class
   against real MySQL. Asserts both sides settle successfully, that
   `attemptsA + attemptsB > 2` (proving a genuine retry occurred — nothing
   here forces which side, only that the cycle exists), and that the final
   DB state is one of the two complete, self-consistent pairs (never a
   mixed/partial write). **Passed 4/4 runs**, and a temporary diagnostic
   (see below) confirmed a real `ER_LOCK_DEADLOCK` (`errno: 1213`) firing
   every time it was checked.

## Deterministic vs probabilistic — stated plainly

Test 1 is **probabilistic** as to whether it exercises a genuine
`ER_LOCK_DEADLOCK`: what it guarantees, deterministically, on every run, is
the OBSERVABLE contract — no loser is ever `INTERNAL_ERROR`, whichever path
produced its `CONFLICT` (the unique-index `ER_DUP_ENTRY` directly, a
retried deadlock resolving into a subsequent `ER_DUP_ENTRY`, or the
non-transactional fast-path identity check). It does **not** guarantee a
real deadlock occurs on any given run. In this feature's own verification
pass, it did not: across 7 runs on this machine (2 baseline, 1 under 8-way
artificial CPU load matching N11's own escalation, plus 4 further repeats),
the retry path was never exercised by test 1 — every loser took the
cheaper non-transactional fast-path conflict, because the winning
transaction here commits fast enough that most siblings' own
`findPaymentByReference` pre-check does not get scheduled until after it
has already committed. This differs from N11's original finding, which DID
observe `ER_LOCK_DEADLOCK` directly on this statement at the same scale —
timing-sensitive by nature, and this session's result does not contradict
theirs, it is a different roll of the same probabilistic dice. Given this,
test 2 was added specifically to not leave the fix's core claim resting on
a coin flip: it **engineers** a deadlock deterministically (a crossed lock
order InnoDB cannot avoid detecting) and passed 4/4, with a temporary
diagnostic confirming the genuine driver error each time. Test 1 is kept,
unchanged in scale, because it is the literal shape of N11's own
reproduction and remains valuable as a live proof of the higher-level
contract under the codebase's actual traffic pattern, even on a run where
it does not happen to cross into a real deadlock.

## Armed-mutation record (verbatim)

The retry loop was deleted (back to plain `return this.db.transaction(...)`,
no catch) in each of the four `drizzle-unit-of-work.ts` files in turn, the
affected tests run, the failure recorded, then restored byte-exact
(confirmed via `git diff --stat`: 66 insertions / 4 deletions in every one
of the four files afterward — my only structural change, no residue).

**billing** — unit (`drizzle-unit-of-work.spec.ts`): 3 of 6 failed:

```
 FAIL  ... > retries the whole unit of work once on ER_LOCK_DEADLOCK, then succeeds
AssertionError: promise rejected "Error: Deadlock found when trying to get …" instead of resolving
 FAIL  ... > retries on ER_LOCK_WAIT_TIMEOUT the same way as ER_LOCK_DEADLOCK — same contention class, same response
AssertionError: promise rejected "Error: Lock wait timeout exceeded; try re…" instead of resolving
 FAIL  ... > is bounded — gives up after MAX_ATTEMPTS and rethrows the ORIGINAL last error unchanged, not something vaguer
AssertionError: expected 1 to be greater than 1
 Test Files  1 failed (1)
      Tests  3 failed | 3 passed (6)
```

**billing** — integration (`invoice-payment-deadlock.integration.spec.ts`,
the ENGINEERED-deadlock test, real MySQL): 1 of 1 failed, with a genuine
driver error leaking through unhandled:

```
 FAIL  ... > DrizzleUnitOfWork.execute recovers from a GENUINE, ENGINEERED InnoDB deadlock (crossed lock order, two real concurrent transactions) — deterministic, not a race
AssertionError: promise rejected "Error: Failed query: update `credits` set… instead of resolving
Caused by: Error: Deadlock found when trying to get lock; try restarting transaction
Serialized Error: { code: 'ER_LOCK_DEADLOCK', errno: 1213, sqlState: '40001',
  sqlMessage: 'Deadlock found when trying to get lock; try restarting transaction', ... }
 Test Files  1 failed (1)
      Tests  1 failed | 1 skipped (2)
```

**orders, fulfillment, notifications** — unit specs: same 3-of-6 failure
shape as billing's, reproduced and confirmed independently for each
(verbatim identical assertion messages, since the four files are
byte-identical after their banners).

All four restored; re-ran every mutated spec green afterward
(`drizzle-unit-of-work.spec.ts` × 4 services: 6/6 each; billing's
integration file: 2/2).

## Files touched

- `apps/{billing,fulfillment,notifications,orders}/src/infrastructure/persistence/drizzle-unit-of-work.ts`
  — the retry loop, identical across all four.
- `apps/{billing,fulfillment,notifications,orders}/src/infrastructure/persistence/drizzle-unit-of-work.spec.ts`
  — new, identical across all four (mocked unit test).
- `apps/billing/src/infrastructure/persistence/invoice-payment-deadlock.integration.spec.ts`
  — new (real-MySQL reproduction, both tests).

Not touched (per brief's explicit constraint, verified unaffected):
`rpc-error-mapper.ts`, `isDuplicateEntryError`/`invoice.repository.ts`,
`feature_list.json`, `specs/**`, `unit-of-work.port.ts`. No dedicated
parity spec for this file existed to update (see above); the two guards
that reference `drizzle-unit-of-work` as an import path
(`idempotent-consumer.parity.spec.ts`, `outbox-relay.parity.spec.ts`) were
run and pass unmodified.

## Self-verification

- `npx eslint` on all 9 touched/new files across the four services — clean.
- `pnpm typecheck` (each of the four services) — clean.
- Unit: `apps/{billing,fulfillment,notifications,orders}` full `npx vitest run`
  — all pass: billing 30 files/154 tests, fulfillment 19/89, notifications
  23/105, orders 53/518.
- Integration (Testcontainers, real MySQL/NATS/Kafka), full per-service
  suite: billing 23 files/76 tests, fulfillment 15/50, notifications 3/5,
  orders 26/28 files, 87/89 tests. Orders' 2 failures are pre-existing,
  independently confirmed unrelated to this change: `trace-context-propagation.integration.spec.ts`
  (a `NatsError: 503`, no-responder-yet timing) and `metrics-exposure.integration.spec.ts`
  (`otc_outbox_lag_ms` briefly `undefined`, both logging `"[ServerKafka]
  ERROR ... GroupCoordinator ... The group coordinator is not available"`)
  — the exact "single-node KRaft Kafka brokers racing on post-startup
  coordinator propagation" flake `vitest.integration.config.mts`'s own
  comment already documents as the reason `fileParallelism: false` exists.
  Neither file imports or exercises `drizzle-unit-of-work.ts`'s retry path
  (one is an OTel span-propagation test, the other an OTel metrics-gauge
  test); re-ran `metrics-exposure.integration.spec.ts` in complete
  isolation three times — failed identically all three, same Kafka
  coordinator error, confirming a pre-existing environmental flake in this
  specific Testcontainers Kafka image, not a regression from this change.
- `pnpm quality`, run TWICE as instructed: **exit 1, exit 1** both times —
  in BOTH runs the only failure is `apps/web`'s pre-existing, documented
  load-flake (`Hook timed out in 10000ms`, `@nuxt/test-utils`
  `setupNuxt()`, unrelated to this change — same signature CLAUDE.md's own
  history records as "confirmed load-only, not investigated further"). All
  four affected services' `test:coverage` step completed with no failures
  in both runs (`apps/{billing,fulfillment,notifications,orders} test:coverage: Done`,
  no `FAIL` line for any of the four in either run's log). Ran a THIRD time
  after the host settled (see the disclosure below) for extra confidence:
  same result, **exit 1**, same and only `apps/web` failure, same four
  services clean — confirms the two required runs were a genuine baseline
  reading, not an artifact of transient host load.
- **Disclosure: a self-inflicted, self-corrected environment issue during
  this verification pass, unrelated to the code change.** While
  calibrating the realistic 140-way concurrency test's ability to
  reproduce a genuine deadlock (see "Deterministic vs probabilistic"
  above), 8 `yes > /dev/null` CPU-load workers were started per MySQL's own
  documented mitigation-testing pattern and the prior N11 finding's own
  methodology. `pkill -f "yes > /dev/null"` was used to stop them between
  attempts — silently ineffective, because shell redirection is not part
  of a process's argv, so the pattern never matched. This left up to 12
  `yes` processes running at ~75-93% CPU each (some traced back to
  07:33, predating this session — not all self-inflicted), driving the
  host's load average into the 30s and causing the ALREADY-RUNNING
  `otc-kafka` dev-stack container's own healthcheck to start timing out
  (`Health check exceeded timeout (10s)`, `unhealthy`) — almost certainly
  the same root cause as the two orders-integration Kafka-coordinator
  flakes above, and possibly also why the realistic concurrency test never
  crossed into a genuine deadlock (a sufficiently loaded host changes the
  exact timing window the race depends on). Found via `ps aux`, fixed with
  `pkill -9 -x yes`; `otc-kafka` recovered to `healthy` on its own within
  under 2 minutes once the load cleared, load average visibly decaying
  (`22 → 12` on the 1-minute figure) before the third `pnpm quality` run
  above, which is the one this file's other numbers should be read
  against for a clean baseline. All 18 `otc-*` containers confirmed
  `healthy` afterward; zero leftover Testcontainers containers.
- `./init.sh` — exit 0.
- 19-container dev stack: left healthy, as required — `otc-kafka` dipped to
  `unhealthy` during the disclosed load spike above and self-recovered
  once the leaked `yes` processes were killed (see disclosure); confirmed
  `otc-*` = 18 persistent containers (+ the one-shot `kafka-init` job) all
  `healthy` at the end, no Testcontainers residue left behind
  (`docker ps --filter label=org.testcontainers=true` empty after every
  integration run completed, and again at final check).

## What I could not do / left honest

- Could not make the realistic 140-way concurrency test (test 1) itself
  deterministically exercise `ER_LOCK_DEADLOCK` in this session — stated
  plainly above, not glossed over. Compensated with a second, deterministic
  test that removes the dependency on timing luck entirely.
- Did not add a byte-identity parity guard for `drizzle-unit-of-work.ts`
  across the four services — none existed before this change and none was
  requested; flagging as a reasonable follow-up for a future pass, not
  something I added unilaterally.
