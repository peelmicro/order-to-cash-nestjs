# Current session

> Working memory for the **active** session. Written *while* working, not at the
> end. On session close, move the summary into `progress/history.md` (with the
> effort record) and reset this file to the template below.

**Feature:** `final_checkpoint` (id 38, phase 25, `sdd: false`)
**Status:** `in_review` — REJECTED once (`progress/review_final_checkpoint.md`: 5 blocking + 1 blocking-nit + 6 non-blocking); defects being closed.
**Session started:** 2026-08-31

40 of 41 features `done`. Only 38 (`final_checkpoint`) remains.

## Goal

Close Phase 25 honestly: every `R1`–`R63` traced to a green test, `progress/` snapshots versioned across genuinely different states, and `specs/shared/` clean enough that assessment #8 can start from it unchanged.

## Decisions taken this session

- **Rule 3 amended to admit a `Scoped` class — with ratification as the bar, not disclosure.** A row whose shortfall is disclosed only by its own author is explicitly *not* ratified ("the author marking their own homework") and blocks the gate exactly as a `TODO` does. This was not theoretical: on its first real test it caught `R58`, flipped green by its own author on a carve-out that appeared in none of the prior records.
- **`R56` ratified as a scoped deferral** at the human gate, with its three exclusions stated in the cell: no Gateway process in the test fleet, the Projector excluded, and no assertion of a span on fact consumption.
- **`R58` closed in code rather than ratified.** The audit named four untraced log sites; sweeping the two services found **nine**.
- **C7 reworded to hold the no-stack-specifics standard against the *reusable part*** — every normative rule plus columns 1–4 of the matrix — while exempting each assessment's own Status column and any paragraph explicitly labelled as one assessment's aside.
- **The README was rewritten away from being an internal post-mortem**, on the human's instruction: Quick Start at the top, ASCII diagrams (GitHub failed to render Mermaid), no machine-specific measurements, no `R<n>` numbers in reader-facing prose, and the failure diary replaced by the three principles the discipline actually rests on.

## Blockers

None outstanding. Awaiting re-review once the six blocking findings are closed.

## Notes

- **The leader's error rate is again the thing worth carrying forward.** The coverage tallies in `test-matrix.md` were mis-parsed **four times** by ad-hoc regex, every attempt matching historical prose inside Status cells; an earlier filename matcher reported 144 missing test files that all existed. The reliable checks were the mechanical guard, the file owner's recount, and reading the cells by hand. A tool's output is a hypothesis, not evidence.
- **The `R58` exclusion I verified and passed was only half the paragraph.** The malformed-envelope carve-out is legitimate and precedented; a second carve-out in the same sentence — the console notification sender, which is the *production degradation fallback* and already holds the `correlationId` on the object it is handed — was not. Checking one claim in a sentence is not checking the sentence.
- Two ledgers remain unwatched: the DLQ and `saga_ignored_facts`. Correct, complete, and invisible to any operator.

---

## Template (reset to this on session close)

```markdown
# Current session

**Feature:** `<name>` (id <n>, phase <n>)
**Status:** <status>
**Session started:** <date>

## Goal

## Decisions taken this session

## Blockers

## Notes
```
