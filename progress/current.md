# Current session

> Working memory for the **active** session. Written *while* working, not at the
> end. On session close, move the summary into `progress/history.md` (with the
> effort record) and reset this file to the template below.

**Feature:** `documentation_demo` (id 37, phase 24, `sdd: false`)
**Status:** `in_review` — REJECTED once (`progress/review_documentation_demo.md`, 6 blocking + 5 non-blocking); defects being closed.
**Session started:** 2026-08-30

39 of 41 features `done`. Only 37 (`documentation_demo`) and 38 (`final_checkpoint`) remain.

## Goal

Close Phase 24: reproducible media capture, then the documentation Phase 24 was always meant to be — architecture and saga diagrams, the Kafka-vs-NATS matrix built from this project's own examples, DLQ inspection, trade-offs, assumptions, and an AI-process section written to the honesty discipline rather than around it.

## Decisions taken this session

- **Media capture is a script, not a ritual.** `scripts/capture-media.mjs` / `capture-demo.mjs` (`pnpm media:capture` / `media:demo`) regenerate 9 screenshots and the compensation GIF from a live stack, because #8 and #9 inherit tooling better than they inherit artefacts, and an un-regenerable screenshot becomes a lie as the UI moves. The two n8n images stay manual — n8n 2.x dropped `N8N_BASIC_AUTH_*` for an owner account whose credentials are not in `.env`.
- **Mailtrap removed rather than worked around.** Its 50/month sandbox quota had silently dead-lettered 728 facts. The adapter was always generic nodemailer-over-SMTP, so Mailtrap demonstrated nothing a self-hosted sink does not, and it was the last real password in `.env`. Mailpit now runs in `docker-compose.infra.yml`.
- **`.env` regenerated from `.env.example`.** 58 variables documented in the example were absent from the real file, including `KAFKA_BROKERS`, which had been working by accident off a code default rather than by configuration.
- **The login rate limit closed a contract gap, not a feature request.** `openapi.yaml` had declared `429` on `POST /auth/login` since Pass B with nothing implementing it. Rejected once by review over a config loader where a stray space bricked login entirely and a typo silently disabled the limit.
- **`R63` minted** — the `429` had no requirement above it and no matrix row. Traceability walks requirement → test, so it is structurally blind to a contract element with nothing requiring it. That is exactly why the promise survived unnoticed.

## Blockers

None. Awaiting the human's re-review call once the review defects are closed.

## Notes

- **The leader's own error rate this session is the thing worth carrying forward.** A grep anchored to one indentation depth returned empty and was reported to `spec_author` as established fact ("no `headers:` block exists anywhere"); the file had six. A Jaeger query that looked obviously right captured a 1-span health-check trace, was reported as success, and overwrote a good committed screenshot. A README citation was written with a line number nobody opened. Each is the same shape: **a plausible claim, asserted without a check** — the exact pattern the README's own honesty section names.
- **Two quiet ledgers remain unwatched**: the DLQ and `saga_ignored_facts`. Both correct, both complete, neither visible to any operator. The strongest remaining candidate before Phase 25.
- n8n workflows 1–4 are Published and generating orders continuously; unpublish when demo capture is finished.

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
