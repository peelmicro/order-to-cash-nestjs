# `test_matrix_guard` — harness work, not a backlog feature

Builds a guard for `specs/shared/test-matrix.md` (finding **H2**,
`progress/review_gateway_rest_auth.md` Round 3) and does the cheap half of
**G6** (same review). Not a backlog feature: no `feature_list.json` entry is
touched, no status is flipped.

## Part 1 — the matrix guard

### Where it lives, and why

`apps/orders/src/test-matrix-guard.spec.ts`. `specs/shared/` is inherited
**verbatim** by assessments #8 and #9, so a `.spec.ts` inside it would embed a
TypeScript test in a directory the other two assessments read as prose —
exactly the stack leakage `CLAUDE.md` forbids. The guard sits beside the
matrix instead, in the same place this repo already puts cross-cutting,
whole-repo text/fs guards that walk every `apps/*` directory:
`idempotent-consumer.parity.spec.ts` (OI12) and `bare-json-nats.parity.spec.ts`
(G5) both live in `apps/orders`. `apps/orders` also already hosts the saga
orchestrator — the one component whose own correctness is defined *across*
every other service's facts, the same vantage point a traceability guard
needs. Any of the other five services would have worked structurally; orders
is the one with precedent, and it is where the guard now lives.

### The verbatim/précis convention

Every `describe`/`it` string quoted after a `›` in `test-matrix.md` — in
backticks or in *italics* — is now defined (in the matrix's own preamble,
lines 61-77) as a **verbatim, character-exact quotation**, UNLESS it carries a
leading `~` immediately before its opening backtick/asterisk (e.g.
`` ~*a précis, not a quotation* ``), which marks it as a deliberate
**précis** — a paraphrase, a summary of several cases, or a title with
something dropped for brevity — exempt from the exact-match check. `~` was
chosen because it does not appear anywhere else in the file (grep-verified
before choosing it) and collides with no existing markdown construct there.

The convention is stated in full in the matrix's own preamble
(`specs/shared/test-matrix.md`, immediately after "The `›` separator
introduces the test case name inside the file") and restated in the guard's
own header comment.

### What the guard checks

For every `**R<n>**` row: (1) every cited `apps/**.spec.ts` **or**
`packages/**.spec.ts` path exists on disk (the brief asked for `apps/**`;
`packages/**` is included too since R1–R4/R11 cite `packages/shared-kernel`
paths under the identical risk — a superset of the ask, not a narrowing); (2)
every **unmarked** citation's quoted text is found, byte-for-byte after
normalisation, inside the file it is cited against.

Extraction anchors strictly on the `›` separator the matrix's own preamble
documents, associating each citation with the nearest preceding
`apps/**.spec.ts`/`packages/**.spec.ts` path anchor on the same row-line.
This was a deliberate choice over "every `*italic*` span in the row is a
title": while auditing the file I found genuine prose-emphasis italics not
meant as citations at all — `*port-refusal*` (R39) and `*imported*` (R54),
both mid-sentence emphasis, neither preceded by `›`. Anchoring on `›` avoids
treating either as a fabricated citation.

### Normalisation, and why each step is legitimate (not a weakening)

Auditing all 135 citations in the file by hand against the actual test
sources (see the check script's evolution below) turned up four purely
cosmetic reasons a genuinely verbatim quotation can still fail a naive
substring check, all now normalised on both sides before comparison:

- markdown backslash-escapes (`\<`, `\>`, `\_`, `` \` ``) in the matrix's own
  prose — the rendered character has no backslash (R11);
- JS backslash-escaped apostrophes inside single-quoted `it()` strings — the
  runtime string value has no backslash (R39, R52, R53);
- a long `it()` title split across two adjacent JS string literals joined by
  `+` for line length — one runtime string, not one contiguous substring of
  the raw source text (R53, R55);
- typographic vs. straight quotes (`’`/`'`) — the same character written two
  ways by two different editors (R55).

None of these loosen what counts as a match for a citation that has actually
drifted — a renamed, deleted or summarised test still fails every one of
these normalisations, because the underlying words differ, not just their
escaping. Proven by arming exactly that (see "Two armed failures" below).

### Six citations marked `~` (matrix's real drift, found and marked, not silently fixed)

Auditing produced **six** genuine précis citations, all pre-existing in the
matrix and now marked rather than rewritten (per the brief: "if it does not
[pass unmodified], you have found real drift: report it, do not silently
correct the matrix"). Two are the exact examples H2 itself named:

- `R54`'s `mongo-order-read-model.adapter.spec.ts` citation —
  `findById/findByOrderReference/list all issue \`Collection.find*\` calls…`
  — a précis of **three separate** `it` titles presented in the verbatim
  position (H2's own first example).
- `R54`'s `R53/R54 — GET /orders excludes a placeholder document from the
  list` citation — drops the real title's `(no orderReference yet)` clause
  (H2's own second example).

Four more turned up during the audit, all deliberate mid-sentence
truncations ending `...`, not drift:

- `R42`'s integration-half citation (`...simulated_cents_rule...`);
- `R49`'s three integration-half citations (`an amount mismatch...`, `a
  currency mismatch...`, `a DIFFERENT paymentReference...`).

All six are cosmetic truncations/summaries of otherwise-correct evidence —
none misdescribes what the cited test actually proves, consistent with the
Round 3 reviewer's own finding ("neither misstates what is tested… the drift
lives in the titles, not the paths").

### Two armed failures (verbatim)

Per the brief, two fake rows were appended to the **real**
`specs/shared/test-matrix.md` (via `cp` backup, append, run, restore —
verified byte-identical afterwards with `diff`), each proven to fail naming
the offending row and cell, then reverted:

```
AssertionError:   - [R9001] (path) R9001 cites "apps/orders/src/domain/__this-file-does-not-exist__.spec.ts", which does not exist on disk
  - [R9002] (title) R9002's title citation of "apps/orders/src/domain/order.spec.ts" claims the verbatim text "this exact sentence has never appeared in any test title anywhere in this repository, XK7Q", which was not found (after normalisation) inside that file. If this is a deliberate paraphrase, mark it with a leading ~ per this document's own preamble; if not, the citation has drifted from the actual test.: expected [ { rowId: 'R9001', …(4) }, …(1) ] to deeply equal []
```

Both name the row (`R9001`/`R9002`), the cell kind (`path`/`title`), and the
exact offending text. `git diff specs/shared/test-matrix.md` was empty after
the restore, confirmed with `diff` against the pre-mutation backup.

The same two fixtures are also permanently armed as part of the guard's own
suite (`self-test — armed against synthetic fixture rows`, 4 cases): the two
failure cases above, one proving the `~` escape hatch actually suppresses the
same fabricated title, and one proving the checker is not vacuously red
(a real citation of a real title in a real file passes clean). None of the
four touches the real matrix file — they construct synthetic one-line
markdown row fixtures and run the identical `findViolations` function the
main test runs against the real file, the same non-vacuity discipline
OI12/G5 use their mode registries for.

### Does the matrix pass unmodified?

**Yes, after the six `~` markings above** (which are additive punctuation,
not evidence-text changes — no Status verdict, no evidence claim, no path was
altered). No Status verdict or evidence claim in the matrix was touched;
`git diff specs/shared/test-matrix.md` is confined to: the new preamble
paragraph (lines 61-77) and the six `~` insertions. No genuine drift (a
citation naming a test that does not exist, or a title that has actually
been renamed) was found — the 53 `apps/**.spec.ts` paths the Round 3 reviewer
verified were already confirmed correct, and this guard confirms the titles
now cited verbatim are, in fact, verbatim.

### What the guard cannot catch (stated in its own header, restated here)

- A cell whose **prose** describes the wrong behaviour while citing a real,
  correctly-named test — G1 was partly this; a textual check cannot read
  whether a citation's surrounding sentence is *true*, only whether the
  quoted string exists.
- A `~`-marked précis that is an **unfair** summary. The marker is trusted,
  not policed.
- A citation that does not follow the documented `path › [describe] › *case*`
  shape at all — a handful of citations in the file use a different lead-in
  (e.g. `— (1) *title*` without a preceding `›`) and are invisible to this
  guard's extraction. Widening extraction to catch every free-form prose
  shape risks false positives on ordinary italic emphasis (the
  `*port-refusal*`/`*imported*` cases found during the audit) — the guard
  trades recall for zero false positives on prose, the same trade-off this
  repo has learned to prefer after OI12/F2/the projector import-scan.

## Part 2 — G6's cheap half

`apps/orders/src/main.ts` now **exports**
`createOrdersNatsMicroserviceOptions(connection)` — the same function
`bootstrap()` calls for the `orders.create` NATS microservice, taking only
`servers`/`user`/`pass` as parameters (the part that genuinely differs
between a Testcontainers instance and runtime config) while fixing the
bare-JSON `deserializer`/`serializer` pair internally (the part F1 was
actually about).

`orders-create-wire.integration.spec.ts` now **imports**
`createOrdersNatsMicroserviceOptions` instead of hand-restating the pair —
removing the exact class of drift F1 exploited (two independent copies of
the same config, one of which silently fell behind).

`main.ts`'s `void bootstrap()` at module scope was guarded with
`if (require.main === module)` — required because the spec now genuinely
`import`s `main.ts` (not just reads it as text, the way `main-kafka-options
.spec.ts` does), and an unguarded `bootstrap()` would try to construct
`AppModule` (a real MySQL connection) as a side effect of that import.
`apps/orders/package.json` declares `"type": "commonjs"`, so
`require.main === module` is the correct (and only) guard shape here — no
`import.meta.url` ESM equivalent is needed or appropriate.

**Verified this actually strengthens the regression guard, not just removes
duplication.** Baseline run: 4/4 green (real MySQL + real NATS
Testcontainers). Import side-effect check: importing `main.ts` did **not**
trigger `bootstrap()` — confirmed by the baseline run completing without
attempting to connect `AppModule`'s own MySQL client. Armed: removed the
bare-JSON pair from `createOrdersNatsMicroserviceOptions` in `main.ts` alone
(the spec file untouched) — both bare-JSON cases failed with
`NatsError: TIMEOUT`, exactly the F1 regression shape, while both
`ClientProxy` cases still passed. Restored via `cp` from a pre-edit backup;
`diff` confirmed byte-identical. This is a **stronger** invariant than
before: previously, deleting the pair from `main.ts` left every spec green
(G6's own diagnosis, "no spec imports `main.ts`"); now the spec's own
`app.connectMicroservice` call uses the same function `bootstrap()` calls, so
there is nothing left to independently mirror, and a regression in `main.ts`
is now provably caught by this spec rather than merely by inspection.

`orders-acceptance.integration.spec.ts` (G7) was **not** touched — it
deliberately drives `ClientProxy` without the bare-JSON pair, a ruled and
documented choice (G7, accepted in Round 3) proving `ClientProxy` is
wire-agnostic here; adding the pair there would duplicate coverage, not
extend it.

## Files touched

- `apps/orders/src/test-matrix-guard.spec.ts` — new. The guard (Part 1).
- `specs/shared/test-matrix.md` — preamble paragraph (lines 61-77) stating
  the verbatim/précis convention; six `~` markings on pre-existing précis
  citations. No Status verdict, no evidence claim, no path changed.
- `apps/orders/src/main.ts` — exported `createOrdersNatsMicroserviceOptions`
  and `OrdersNatsConnectionOptions`; `bootstrap()`'s call site now uses it;
  `void bootstrap()` guarded by `require.main === module`.
- `apps/orders/src/orders-create-wire.integration.spec.ts` — imports
  `createOrdersNatsMicroserviceOptions` from `./main` instead of restating
  the bare-JSON pair inline.

## Traceability

Not an `R<n>`-bearing feature; `specs/shared/test-matrix.md` itself is not
touched in a way that changes any row's Status. No `test-matrix.md` row is
added for this guard (it is infrastructure for the matrix, not a requirement
the matrix tracks).

## `pnpm quality`

- `pnpm --filter @otc/orders exec eslint .` → 0.
- `pnpm --filter @otc/orders typecheck` → 0.
- `pnpm --filter @otc/orders test` → 33 files / 415 tests passed (includes the
  6 new `test-matrix-guard.spec.ts` cases).
- `pnpm --filter @otc/orders test:coverage` → 91.48% statements overall (well
  above the 60% floor); domain layer 98.5% statements.
- `orders-create-wire.integration.spec.ts` (Testcontainers: mysql:8.4.11 +
  nats:2.14.5-alpine) → 4/4 green, both baseline and after restore.
- Root `pnpm quality` (lint + typecheck + test, all packages): see the tail
  of the run recorded at close-out below.
- `./init.sh` — not re-run (unaffected by this change; no harness file
  touched).

## What surprised me

- Prose-emphasis italics inside the matrix's own Status column
  (`*port-refusal*`, `*imported*`) are indistinguishable from citation
  syntax by a naive "every `*...*` is a title" rule — the extractor had to
  anchor on `›` specifically to avoid two false positives before it ever
  touched real citations.
- Most of the "mismatches" a first-pass substring check found were not drift
  at all — they were markdown escaping, JS string escaping, or multi-line
  JS string-literal concatenation, three purely cosmetic reasons a
  byte-for-byte comparison of RAW SOURCE TEXT fails a genuinely verbatim
  quotation. Only after normalising all three did the six real précis
  citations stand out cleanly, which is exactly why the header documents
  each normalisation's justification individually rather than folding them
  into one opaque "clean up the string" step.
- The two H2-named examples (`findById/findByOrderReference/list...` and the
  dropped `(no orderReference yet)` clause) were the ONLY citations, out of
  135, that the Round 3 reviewer had already read closely enough to name —
  and the mechanical audit found four more of the same class the reviewer's
  prose-reading pass had not called out individually, confirming H2's own
  point that this class of drift needs a mechanical check, not another
  close reading.
