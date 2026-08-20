# impl_shared_kernel

**Feature:** `shared_kernel` (id 7, phase 5) — `packages/shared-kernel`
**Status set to:** `in_review`

## What was built

`packages/shared-kernel/src/` — pure TypeScript, zero runtime dependencies,
implementing `specs/shared/domain-model.md` §2 (shared-kernel value objects)
and the fact envelope of §7.1.

### Value objects (`src/domain/`)

- **`money.ts`** — `Money`: integer minor units + ISO 4217 alpha-3 currency.
  `Money.of()` rejects non-number, non-finite, non-integer and unsafe-integer
  amounts (`InvalidMoneyAmountError`). Currency is validated for ISO 4217
  *shape* only (3 uppercase letters) — catalogue membership is deliberately
  left to the Orders reference catalogue, not this dependency-free kernel;
  documented in the file's doc comment. `add`/`subtract`/`compareTo` throw
  `CurrencyMismatchError` on a currency mismatch (M2); `add`/`subtract`/
  `multiply(Quantity)` are closed over the same currency (M3); `isNegative`/
  `isZero`/`isPositive`/`negate` (M4); `mod100()` is the `.99` simulator
  accessor, made safe for negative amounts via `((n % 100) + 100) % 100`.
  Equality by value.
- **`quantity.ts`** — `Quantity`: strictly positive integer, rejects zero,
  negatives and fractions (`InvalidQuantityError`).
- **`gln.ts`** — `GLN`: exactly 13 digits with the real GS1 mod-10 check
  digit algorithm (`GLN.computeCheckDigit`, exported for direct testing).
  Rejects wrong length, non-digits and a bad check digit
  (`InvalidGlnError`).
- **`unique-id.ts`** — `UniqueId`: UUID v4 via `crypto.randomUUID()` (Node
  built-in, not a dependency); `UniqueId.from()` reconstructs from an
  existing string with UUID-v4-shape validation (`InvalidUniqueIdError`).
- **`business-reference.ts`** — one abstract `BusinessReference` base
  (`<PREFIX>-######`) with four sibling exported types fixing their own
  prefix so they stay non-interchangeable even though structurally
  identical: `OrderNumber` (`ORD-`), `DespatchReference` (`DES-`),
  `InvoiceReference` (`INV-`), `CreditLineReference` (`CR-`). Each has
  `.of(value)` (parse + validate) and `.fromSequence(n)` (zero-pad format).
  `InvalidBusinessReferenceError` on either failure.

### Base classes (`src/domain/`)

- **`domain-error.ts`** — `DomainError extends Error`, abstract, protected
  constructor, `abstract readonly code: string`.
- **`entity.ts`** — `Entity<T>`: identity-based equality via `UniqueId`. `T`
  is a self-referencing phantom type parameter (`class Order extends
  Entity<Order>`) for nominal typing between different aggregate types.
- **`aggregate-root.ts`** — `AggregateRoot<T> extends Entity<T>`:
  `addDomainEvent()` (protected, for subclasses) and `pullDomainEvents()`
  (returns-and-clears, in append order).
- **`event-envelope.ts`** — `DomainEventEnvelope<TPayload>` interface
  matching domain-model.md §7.1 exactly (`eventId`, `eventType`,
  `aggregateId`, `correlationId`, `causationId`, `occurredAt`, `payload`);
  `createDomainEvent()` builds one, generating `eventId` in the domain if
  not supplied; `assertValidDomainEventEnvelope()` is the standalone
  validator (also usable directly, which is how the "absent/null/empty
  field" test constructs malformed envelopes without needing an invalid
  `createDomainEvent()` call). `eventType` pattern:
  `^[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*\.v[1-9][0-9]*$`.

### Public API

`src/index.ts` is a deliberate barrel — every value object, `DomainError`,
`Entity`, `AggregateRoot`, the envelope type/functions, and every concrete
error class, nothing else (the abstract `BusinessReference` base stays
un-exported). `src/index.spec.ts` asserts the exact export list and proves
the barrel is independently usable end to end.

## Requirement traceability (`specs/shared/test-matrix.md`)

Flipped from `TODO`:

| R-id | Test | File |
|---|---|---|
| R1 (domain-unit half; the API half stays TODO — out of scope for this package) | *represents 1 242,50 EUR as 124250 minor units and offers no decimal representation* | `packages/shared-kernel/src/domain/money.spec.ts` |
| R2 | *raises a domain error when EUR and GBP amounts are added, subtracted or compared* | `packages/shared-kernel/src/domain/money.spec.ts` |
| R3 | *refuses zero, negative and fractional quantities and creates no value object* | `packages/shared-kernel/src/domain/quantity.spec.ts` |
| R4 | *accepts a hand-computed valid GLN (independent oracle)* + wrong-length/non-digit/bad-check-digit/systematic-mutation cases | `packages/shared-kernel/src/domain/gln.spec.ts` |
| R11 | *refuses an envelope with an absent, null or empty field* / *refuses an eventType that does not match the pattern* | `packages/shared-kernel/src/domain/event-envelope.spec.ts` |

R1's row is intentionally left **partially** green (domain unit proven here;
the API-level "every monetary field of every response" assertion belongs to
the Gateway feature, not this package) — the matrix rule says partial
coverage must stay visible, not be hidden behind a green row.

`OrderNumber`/`DespatchReference`/`InvoiceReference`/`CreditLineReference`
have no dedicated `R<n>` in `requirements.md` (domain-model.md's
traceability table maps all of §2 to R1–R4 only), so no matrix row was
touched for them; they are still fully built and tested per
domain-model.md §2.3.

## GLN independent oracle

`gln.spec.ts` hand-derives two valid GLNs by literally applying
domain-model.md §2.4's stated algorithm in a comment (not by calling the
production code): body `123456789012` → check digit `8` → `1234567890128`,
and the all-zeros boundary `000000000000` → check digit `0` →
`0000000000000`. It also proves algebraically-guaranteed exhaustive
mutation coverage: since `gcd(3,10) = gcd(1,10) = 1`, changing any single
digit of a valid GLN by any amount in `[-9,9] \ {0}` always changes the
weighted sum mod 10, so every single-digit mutation of a valid GLN is
provably invalid — the test loops over all 13 positions × 9 replacement
digits each (117 cases) and asserts rejection.

## Files touched

- `packages/shared-kernel/src/index.ts` (real barrel, was a stub)
- `packages/shared-kernel/src/index.spec.ts` (new)
- `packages/shared-kernel/src/domain/*.ts` (10 new source files)
- `packages/shared-kernel/src/domain/*.spec.ts` (10 new spec files)
- `packages/shared-kernel/package.json` — build now points at
  `tsconfig.build.json`; added `test:watch` and `test:coverage` scripts
  (parity with `apps/orders`'s convention)
- `packages/shared-kernel/tsconfig.build.json` (new — excludes `*.spec.ts`
  from the emitted build, same pattern as `apps/orders`)
- `packages/shared-kernel/vitest.config.mts` — removed the now-stale
  "empty stub, passWithNoTests" comment/flag
- `eslint.config.mjs` — extended the domain-purity `files` glob to include
  `packages/shared-kernel/src/**/*.{ts,mts,cts}` (it did not cover the
  package before this feature)
- `specs/shared/test-matrix.md` — flipped R1 (domain-unit half), R2, R3, R4,
  R11 rows to DONE with real file/case names

## Verification (real output)

**1. `pnpm --filter @otc/shared-kernel test`**
```
Test Files  10 passed (10)
     Tests  68 passed (68)
```

**2. Coverage — `pnpm --filter @otc/shared-kernel test:coverage`**
```
Statements   : 100% ( 167/167 )
Branches     : 100% ( 87/87 )
Functions    : 100% ( 76/76 )
Lines        : 100% ( 166/166 )
```
(Threshold gate in `vitest.config.mts` is 80/80/80/80 — well cleared.)

**3. `pnpm quality` at the root** — green: `eslint .` clean, every
workspace's `typecheck` (`tsc --noEmit`) passed, every workspace's `test`
passed (`packages/shared-kernel`: 68/68; other apps: their existing
placeholder `AppController` specs; `packages/contracts`: no test files,
exits 0 as designed).

**4. Runtime proof against the built `dist/` output** (`node -e "..."`
against `packages/shared-kernel/dist/index.js`, produced by
`pnpm --filter @otc/shared-kernel build`):
```
mod100 of 124299: 99
OK: cross-currency add threw CurrencyMismatchError CURRENCY_MISMATCH cannot operate on Money of different currencies: EUR vs GBP
GLN ok: 1234567890128
OK: bad GLN rejected INVALID_GLN
UniqueId: ed18525c-9e7c-491f-993c-263e5f384eb3
```

**5. `dependencies` absent from `packages/shared-kernel/package.json`** —
confirmed programmatically: `"dependencies" in package.json` → `False`.
Only `devDependencies` (`@types/node`, `@vitest/coverage-v8`, `typescript`,
`vitest`, all `catalog:`) are present.

**6. `./init.sh`** — exit 0, "environment and state are coherent"; one
`in_progress` feature at the start of the session, none after flipping to
`in_review`.

## What could not be done / deliberately out of scope

- The API-level half of R1 ("every monetary field of every response is an
  integer accompanied by a currency code") is a Gateway-level assertion —
  no Gateway REST surface exists yet. Left `TODO` in the matrix, correctly
  visible as partial.
- Money's `currency` validation checks ISO 4217 *shape* only, not catalogue
  membership — domain-model.md says "must be a known, seeded currency
  code" but that catalogue is owned by the Orders context's reference data
  (domain-model.md §1: Orders owns "the reference catalogue... currencies"),
  which does not exist yet and is out of scope for a dependency-free
  kernel. Documented in `money.ts`'s doc comment as a deliberate decision.
- `OrderNumber`/siblings have no dedicated `R<n>`; built per
  domain-model.md §2.3 but no matrix row exists to flip.

## Surprises

- TypeScript enforces constructor-accessibility inheritance strictly: a
  subclass of an abstract class with a `protected` constructor that does
  not declare its own constructor inherits the `protected` accessibility,
  so `new SubClass(...)` from outside the hierarchy fails to typecheck even
  though it's a completely ordinary pattern for concrete `DomainError`
  subclasses. Every concrete error class in this package therefore
  redeclares an explicit (public, implicit) constructor calling `super()`.
- The GS1 mod-10 algorithm's alternating weights of 3 and 1 are coprime
  with the modulus 10 in both cases, which makes "every single-digit
  mutation of a valid GLN is invalid" a provable, not just empirically
  observed, property — turned that into a genuinely exhaustive test rather
  than a handful of spot checks.
- The v8 coverage text reporter silently omits any file with 100% coverage
  on every metric from its per-file table (confirmed via `lcov.info`, which
  does list all ten source files); the printed "All files" summary line is
  still the true aggregate, so it is not a coverage-hiding bug, just a
  slightly confusing table view.
