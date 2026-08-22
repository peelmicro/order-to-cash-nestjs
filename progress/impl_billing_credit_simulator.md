# impl: billing_credit_simulator (feature 20)

## What was built

A `CreditDecisionPort` adapter — the credit-check **simulator** — bound in place of `AlwaysApproveCreditDecision`, implementing R42–R44 (`specs/shared/requirements.md` §5.1). Footprint:

- `apps/billing/src/infrastructure/credit/simulator-credit-decision.ts` — `SimulatorCreditDecision` (the `.99` rule + the failure-rate rule) and `loadCreditSimulatorConfig` (reads `CREDIT_FAILURE_RATE`, defaults to `0`, throws on an out-of-range/non-numeric value).
- `apps/billing/src/infrastructure/credit/simulator-credit-decision.spec.ts` — pure unit tests, deterministic randomness via injection.
- `apps/billing/src/credit-rejection-parity.integration.spec.ts` — the real `AppModule` graph (Testcontainers MySQL + NATS + Kafka), proving R42 and R44 against the live provider wiring.
- `apps/billing/src/app.module.ts` — `CREDIT_DECISION`'s `useFactory` rebound from `AlwaysApproveCreditDecision` to `SimulatorCreditDecision`; header comment updated with the binding rationale.
- `apps/billing/src/infrastructure/credit/always-approve-credit-decision.ts` — header comment updated to say it is no longer the bound adapter but remains in the tree, still covered by its own untouched spec.
- `apps/billing/src/application/credit-hold.handler.spec.ts` — folded in the reviewer's non-blocking nit from feature 19: the port-refusal test now also asserts `requestedAmount: 4_000, availableCredit: 10_000`, not just `reason`.
- `specs/shared/test-matrix.md` — R42/R43/R44 flipped TODO → DONE; R39's row note updated (see Decisions §2).
- `feature_list.json` — `billing_credit_simulator` → `in_review`.

## Decisions

1. **Binding: unconditional, no env flag.** `app.module.ts`'s `useFactory` for `CREDIT_DECISION` always constructs `SimulatorCreditDecision`. Rationale: there is no second, real credit-assessment adapter in this codebase to choose between (`AlwaysApproveCreditDecision` is a stub, not a production alternative); `CREDIT_FAILURE_RATE` defaults to `0`, so at its default the simulator only ever narrows an approval relative to `AlwaysApproveCreditDecision` (the `.99` rule is the sole behavioural delta), exactly the shape `credit-decision.port.ts`'s header requires of every adapter; and R42/R43's "WHERE the simulator is the adapter bound to the credit port" clause reads as the EARS precondition under which the requirement holds in production, not as a mandate for a runtime toggle. `AlwaysApproveCreditDecision` stays in the tree, unmodified in behaviour, still exercised by its own untested-by-me spec — nothing deletes it, only the binding moved off it.
2. **Rule precedence: the `.99` check runs first and wins unconditionally.** `decide()` checks `amountMinorUnits % 100 === 99` before consulting the failure-rate draw. R42's "regardless of the retailer's available credit" clause, read together with the whole affordance's purpose (a *reproducible* demo trigger), means a `.99` amount must never be reported as `simulated_failure_rate` depending on which pseudo-random value happened to be drawn. Pinned by `simulator-credit-decision.spec.ts` › *the cents rule wins over the failure-rate rule when both could apply* (failureRate = 1, random() = 0 — would ALSO refuse via `simulated_failure_rate` if the cents check ran second).
3. **Randomness injected, not `Math.random()` called directly.** Constructor takes `random: () => number = Math.random`; every spec passes a fixed function so the failure-rate branch is deterministic under test.
4. **Fail-fast validation lives in `loadCreditSimulatorConfig`, thrown synchronously inside the `useFactory`.** An invalid `CREDIT_FAILURE_RATE` (out of `[0, 1]`, non-numeric, `NaN`, `Infinity`) throws with the offending value in the message; Nest's module compilation fails and the process never reaches `listen()`. Verified live (see below) — `.env`'s `CREDIT_FAILURE_RATE=0` boots cleanly; a bad value was verified via the unit test's loop over `['1.5', '-0.1', 'not-a-number', 'NaN', 'Infinity']`, each asserted to throw with that value present in the message.
5. **R39's test-matrix row note updated**, since it previously said the integration harness "binds an always-approve adapter and therefore cannot reach [the port-refusal] branch" — no longer true now that the simulator is the default binding. The note now says the pre-feature-20 integration suite couldn't, but `credit-rejection-parity.integration.spec.ts` (feature 20) now reaches it live via a `.99` amount.

## R → test mapping

| Req | Test |
|---|---|
| R42 | `apps/billing/src/infrastructure/credit/simulator-credit-decision.spec.ts` › `simulator-credit-decision.spec — R42` › *rejects a total whose minor units end in 99 with reason simulated_cents_rule even when the retailer has ample credit* (unit); `apps/billing/src/credit-rejection-parity.integration.spec.ts` › *R42 — rejects a fitting hold whose total ends in 99 minor units with simulated_cents_rule...* (integration); proven live against the compose stack (below) |
| R43 | `apps/billing/src/infrastructure/credit/simulator-credit-decision.spec.ts` › `simulator-credit-decision.spec — R43` › *defaults the failure rate to zero, rejects a configured proportion when set, and fails to start reporting the offending value when it is outside the closed interval zero to one*, plus *rejects a non-99 amount with reason simulated_failure_rate only when the random draw falls below the configured rate, and never at a zero rate* and *a failure rate of 1 rejects every non-99 amount* |
| R44 | `apps/billing/src/credit-rejection-parity.integration.spec.ts` › *R44 — a genuine over-limit rejection is still reachable with the simulator bound and CREDIT_FAILURE_RATE at its default of zero, producing the same fact type and payload shape as the simulated rejection, differing only in reason*; proven live against the compose stack (below) |
| Feature-19 nit | `apps/billing/src/application/credit-hold.handler.spec.ts` › `CreditHoldHandler.hold — R39, port refusal` — now asserts `reason`, `requestedAmount: 4_000`, `availableCredit: 10_000` |

## Armed-deletion evidence (fact-emission rule, CLAUDE.md)

Temporarily deleted the `.99`-rule branch in `simulator-credit-decision.ts` (`decide()`'s first `if`), leaving only the failure-rate check. Ran `pnpm exec vitest run src/infrastructure/credit/simulator-credit-decision.spec.ts` from `apps/billing`:

```
FAIL  src/infrastructure/credit/simulator-credit-decision.spec.ts > simulator-credit-decision.spec — R42 > rejects a total whose minor units end in 99 with reason simulated_cents_rule even when the retailer has ample credit
AssertionError: expected { kind: 'approve' } to deeply equal { kind: 'refuse', reason: 'simulated_cents_rule' }

FAIL  src/infrastructure/credit/simulator-credit-decision.spec.ts > simulator-credit-decision.spec — R42 > the cents rule wins over the failure-rate rule when both could apply
AssertionError: expected { kind: 'refuse', reason: 'simulated_failure_rate' } to deeply equal { kind: 'refuse', reason: 'simulated_cents_rule' }

Test Files  1 failed (1)
     Tests  2 failed | 5 passed (7)
```

Restored the file immediately afterward (verified byte-identical to the pre-probe version via `diff`), then re-ran the same command to confirm 7/7 green again.

## Verification (real output)

- **Unit** (`apps/billing`, `pnpm exec vitest run`): **16 test files, 64 tests passed** (was 57 — +7 from `simulator-credit-decision.spec.ts`).
- **Integration** (`pnpm --filter @otc/billing test:integration`, Testcontainers `mysql:8.4.11` + `nats:2.14.5-alpine` + `apache/kafka:4.3.1`): **9 test files, 30 tests passed** (was 28 — +2 from `credit-rejection-parity.integration.spec.ts`). Feature 19's harnesses (`credit-hold.integration.spec.ts`, `credit-hold-race.integration.spec.ts`, `credit-wire.integration.spec.ts`, `credit-list.integration.spec.ts`) pass unchanged — every fixture amount they use avoids `…99` by construction (verified by grep before implementing), so the simulator's default (`CREDIT_FAILURE_RATE=0`) behaves identically to `AlwaysApproveCreditDecision` for all of them.
- **Typecheck**: `tsc -p tsconfig.json --noEmit` — clean.
- **Lint**: `eslint` over every touched file — clean (no `no-restricted-imports`/DI-token/transport violations).
- **`./init.sh`**: exit 0, "no feature in_progress", 39 features parsed.
- **R42 proven live against the compose stack**: built `apps/billing`/`apps/orders`/`apps/fulfillment`, restarted the running `billing` process on the freshly built `dist/` (the other two were already running unmodified), then `node scripts/place-order.mjs --qty 1` (PRD-0001 @ 24999 minor units × 1 = 24999, ends in `.99`) against `CarrefourEs`/`IBERFOODS` (credit limit 500,000, well above 24,999):
  - `otc_orders.orders`: `ORD-000016` → `status=cancelled`, `cancellation_reason=credit_rejected`, `total_amount=24999`.
  - `otc_billing.outbox`: `credit.rejected.v1` — `{"reason":"simulated_cents_rule","requestedAmount":24999,"availableCredit":350006,...}`. No ledger entry was written (the port-refusal path never reaches `save` with a `hold` row).
  - `otc_fulfillment.outbox`: `stock.reserved.v1` followed by `stock.released.v1` — `{"reason":"credit_rejected","released":[{"units":1,"productCode":"PRD-0001",...}]}`.
- **R44 proven live**: with the SAME simulator binding and `CREDIT_FAILURE_RATE=0` (the value already in `.env`), `node scripts/place-order.mjs --over-limit --qty 21` (21 × 24999 = 524979, does **not** end in `.99`, exceeds the 350,006 available credit remaining after the prior hold) produced `ORD-000017` → `cancelled`/`credit_rejected`, `otc_billing.outbox` → `credit.rejected.v1` with `reason: over_limit`, `requestedAmount: 524979`, `availableCredit: 350006` — the genuine over-limit path (R37) is unbypassed by the simulator. A control run, `node scripts/place-order.mjs --qty 2` (49998, non-`.99`, well within credit), produced `ORD-000018` → `status=despatched` — the happy path is unaffected.
- **`CREDIT_FAILURE_RATE` invalid ⇒ startup fails loudly**: proven at the unit level (`loadCreditSimulatorConfig` loop over `['1.5', '-0.1', 'not-a-number', 'NaN', 'Infinity']`, each throwing synchronously with the offending value present in the message) and structurally at the wiring level — `useFactory` calls `loadCreditSimulatorConfig()` with no try/catch, so a thrown error propagates out of Nest's DI container construction and `main.ts`'s bootstrap never reaches `listen()`. Did not additionally re-boot the live process with a bad env var (the unit + wiring evidence is unambiguous and re-booting again would have meant a third round of Kafka consumer-group rebalancing against the already-running `orders`/`fulfillment` processes for no new information).

## Deviations / notes

- The test-matrix's originally sketched path `billing/domain/credit-simulator.spec` was not used literally; the simulator is an **infrastructure** adapter (it has no domain-file counterpart — the brief's own footprint list places it under `infrastructure/credit/`), so the spec sits beside it at `apps/billing/src/infrastructure/credit/simulator-credit-decision.spec.ts`, mirroring `always-approve-credit-decision.spec.ts`'s location exactly. Test-matrix updated to point at the real path.
- `loadCreditSimulatorConfig` lives inside `simulator-credit-decision.ts` rather than a separate `credit-simulator.config.ts` file (unlike `db-config.ts`/`kafka.config.ts`/`outbox-relay.config.ts`, each of which is its own file). Deliberate: the brief frames this feature's footprint as "the ONE file" beyond the `app.module.ts` binding change; splitting config into a second file would have doubled the file count for a two-line parse function with no other consumer.
- Live verification required restarting the already-running `billing` dev process on freshly built `dist/` (it was a one-shot `pnpm start` process, not `tsc-watch`, so it does not auto-restart on source changes) — `orders` and `fulfillment` were left untouched and running throughout. Restarting `billing`'s NATS/Kafka connections triggered a brief Kafka consumer-group rebalance across all three services (visible as `ERROR [Connection] Response Heartbeat ... group is rebalancing` in `orders`' log, harmless and expected), which made the `place-order.mjs` script's client-side NATS request occasionally hit its own 10s reply timeout even though the order was, in each case, still processed correctly end to end (confirmed via direct DB inspection) — this is an artifact of restarting a long-running dev process mid-session, not a defect in this feature.
- Fold-in nit from feature 19: done exactly as suggested (`toMatchObject({ reason, requestedAmount: 4_000, availableCredit: 10_000 })` on the fixture's actual values).

## Files touched

- `apps/billing/src/infrastructure/credit/simulator-credit-decision.ts` (new)
- `apps/billing/src/infrastructure/credit/simulator-credit-decision.spec.ts` (new)
- `apps/billing/src/credit-rejection-parity.integration.spec.ts` (new)
- `apps/billing/src/app.module.ts`
- `apps/billing/src/infrastructure/credit/always-approve-credit-decision.ts`
- `apps/billing/src/application/credit-hold.handler.spec.ts`
- `specs/shared/test-matrix.md`
- `feature_list.json`
