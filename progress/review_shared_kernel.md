# review_shared_kernel

**Feature:** `shared_kernel` (id 7, phase 5) — `packages/shared-kernel`
**Reviewer verdict:** **APPROVED** (first pass)
**Date:** 2026-08-19

## Verdict summary

All four acceptance criteria met, all five claimed test-matrix flips honest,
100% coverage claim reproduced exactly, and — the part coverage cannot show —
the suite kills every hostile mutation I threw at it (4/4). The GLN mod-10
implementation was verified against independent GS1 oracles, not just the
spec's own worked example.

## Independent verification (everything re-run, nothing taken on faith)

1. **`pnpm --filter @otc/shared-kernel test`** → `Test Files 10 passed (10)`,
   `Tests 68 passed (68)`. Matches the implementer's claim exactly.
2. **Coverage** (`test:coverage`) → Statements 100% (167/167), Branches 100%
   (87/87), Functions 100% (76/76), Lines 100% (166/166). Matches the report
   digit for digit. Threshold gate 80/80/80/80 present in `vitest.config.mts`.
3. **`pnpm quality`** at root → exit 0 (eslint, all typechecks, all tests).
4. **`./init.sh`** → exit 0, "environment and state are coherent".
5. **Zero runtime dependencies** — `package.json` has no `dependencies` key;
   the only non-relative import in `src/` is `node:crypto` (Node built-in),
   verified by grep.
6. **No Jest anywhere** in the package; Vitest only.
7. **Working tree** — my probe edits were backed up, applied, and byte-for-byte
   restored (`diff -q` clean against backups; suite re-run 68/68 after restore).

## Mutation probes — 4/4 KILLED

| # | Hostile edit | Result |
|---|---|---|
| M1 | `gln.ts` — swap the GS1 weights (3↔1) in `computeCheckDigit` | **KILLED** — 6 tests failed (the independent-oracle and systematic-mutation cases) |
| M2 | `money.ts:77` — delete `assertSameCurrency` from `add()` | **KILLED** — 2 tests failed (R2 cases) |
| M3 | `quantity.ts` — `value <= 0` → `value < 0` (accept zero) | **KILLED** — 1 test failed (R3 refuses-zero case) |
| M4 | `aggregate-root.ts` — `pullDomainEvents` returns a copy without clearing | **KILLED** — 1 test failed (second-pull-returns-nothing case) |

No mutation survived. The assertions are real, not coverage theatre.

## GLN algorithm — independent oracle check

Beyond the spec's own worked example (`123456789012` → check `8`,
hand-recomputed by me: weighted sum 92 → `(10 − 2) mod 10 = 8`), I verified the
built `dist/` output against **GS1's published examples not present in the
tests**:

- `0614141000005` (GS1's canonical example GLN; hand-computed sum 45 → check 5) — **accepted**
- `4012345000009` (GS1 example GTIN-13; hand-computed sum 31 → check 9) — **accepted**
- `0614141000004` (off-by-one check digit) — **rejected**, `INVALID_GLN`

The algorithm is the real GS1 rule; seed-data GLNs in phase 7 are safe.

## R-id → test mapping verified

| R-id | Status | Verified against |
|---|---|---|
| R1 (domain-unit half) | honest **partial** — API half correctly left TODO | `money.spec.ts` › *represents 1 242,50 EUR as 124250 minor units…* — asserts integer amount, currency code, and absence of any decimal accessor |
| R2 | DONE | `money.spec.ts` › add/subtract/compareTo/isGreaterThan/isLessThan all throw `CurrencyMismatchError` EUR vs GBP; no-implicit-conversion case asserts operands untouched |
| R3 | DONE | `quantity.spec.ts` › refuses 0, −1, −100, 1.5, 0.1, NaN, Infinity |
| R4 | DONE | `gln.spec.ts` › hand-derived oracle, wrong length, non-digits, all 9 wrong check digits, and the exhaustive 117-case single-digit-mutation sweep |
| R11 | DONE | `event-envelope.spec.ts` › every field absent/null/empty rejected individually; 9 bad `eventType` shapes rejected; all 13 catalogue types + v2/v10 accepted |

Test-matrix diff inspected: only these five rows changed, R1 visibly partial,
no other rows touched. Envelope field names (`eventId`, `eventType`,
`aggregateId`, `correlationId`, `causationId`, `occurredAt`, `payload`) match
domain-model.md §7.1 exactly.

## Money — spec conformance

- Construction rejects non-number, NaN, ±Infinity, non-integer, unsafe integer
  (incl. the `0.1 + 0.2` float leak) — tested.
- M2 covers add AND subtract AND comparison — tested.
- M3 closed arithmetic incl. `multiply(Quantity)`; no `divide` on the surface — tested.
- M4 negative Money representable — tested. (Rejecting negative *totals* is an
  aggregate rule, correctly not in the kernel.)
- Immutability: `private readonly` fields, no mutators, all operations return
  new instances; the failed-add case asserts operands unchanged.
- `mod100()` correct for negative amounts — tested.

## ESLint domain-purity probe

`eslint.config.mjs` glob includes `packages/shared-kernel/src/**/*.{ts,mts,cts}`.
Probed by injecting `import type { OnModuleInit } from '@nestjs/common'` into
`money.ts`: lint **failed** with the `no-restricted-imports` domain-purity
error (type-only import caught too). Probe removed; file restored.

## CHECKPOINTS walked (C6 not applicable — `sdd: false`; C7 partially applicable)

### C1 — harness complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` exist
- [x] `progress/current.md` and `progress/history.md` exist
- [x] `.claude/agents/` holds all five agents
- [x] Every agent definition declares its model
- [x] `./init.sh` exits 0

### C2 — state coherent
- [x] At most one feature `in_progress` (none after this close)
- [x] Every status in `rules.valid_status`
- [x] Every `done` feature has passing tests associated
- [x] `progress/current.md` describes the active session
- [x] No `blocked` features

### C3 — architecture respected (first feature where this applies in full)
- [x] Domain purity verified **by ESLint**, probed in both directions
- [x] No cross-service database access (no DB code exists yet; nothing violates)
- [x] No shared runtime code beyond shared-kernel/contracts
- [x] `packages/shared-kernel` has zero runtime dependencies (verified)
- [x] Kafka-fact/NATS-RPC classification — N/A yet, no inter-service code
- [x] No stray debug logging, no context-free TODOs (grepped)

### C4 — verification real (first feature where this applies in full)
- [x] `pnpm quality` passes (exit 0, re-run by reviewer)
- [x] Domain tests pure — only `vitest` + relative imports in specs; no framework, DB, broker
- [x] Testcontainers — N/A, no integration surface in this package
- [x] Coverage: 100% across all four metrics (gate ≥80% domain — cleared)
- [x] No Jest anywhere; Vitest only

### C5 — session closed cleanly
- [x] No suspicious untracked files (probe backups live in the session scratchpad, outside the repo)
- [x] `progress/history.md` entry with effort record (written by this review)
- [x] `feature_list.json` reflects true state (`shared_kernel` → `done`)
- [x] Human told what was done and how to test manually (below)
- [x] Reviewer did not commit

### C7 — trilogy reusability
- [x] `specs/shared/test-matrix.md` flips reference concrete files but the
      matrix rows themselves stay stack-agnostic (file-path column is
      per-assessment by design)
- [x] Effort record complete and honest

## Defects

**None blocking.** Two observations for the record (not defects):

1. `Money`/value objects rely on TypeScript `private readonly` + no mutators
   for immutability, not `Object.freeze`. Acceptable — the spec's
   "immutable" is satisfied behaviourally (tested: failed operations leave
   operands untouched) — but a hostile JS consumer could still poke fields at
   runtime. Fine for an internal kernel.
2. Currency validation is ISO-4217 *shape* only; catalogue membership
   ("known, seeded currency code", §2.1) is deliberately deferred to the
   Orders reference catalogue. Documented in `money.ts`'s doc comment and in
   the impl report. **Carry-forward:** the Orders context must actually
   enforce catalogue membership when it lands — do not let this deferral be
   forgotten.

## How to test manually

```bash
pnpm --filter @otc/shared-kernel test           # 68/68
pnpm --filter @otc/shared-kernel test:coverage  # 100/100/100/100
pnpm quality                                    # root gate, exit 0
node -e "const {GLN}=require('./packages/shared-kernel/dist/index.js');console.log(GLN.of('0614141000005').value)"  # after pnpm --filter @otc/shared-kernel build
```
