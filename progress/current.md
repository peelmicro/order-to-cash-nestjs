# Current session

> Working memory for the **active** session. Written *while* working, not at the
> end. On session close, move the summary into `progress/history.md` (with the
> effort record) and reset this file to the template below.

**Feature:** — none active —
**Status:** idle
**Session started:** —

## Goal

Next up: phase 5 — `monorepo_scaffold` (id 6), `shared_kernel` (id 7),
`contracts_package` (id 8). First decision on entry: TypeScript major version
(`typescript@latest` resolves to 7.x; NestJS 11 depends on decorators +
`emitDecoratorMetadata` — pin 5.x unless 7 is verified against `@nestjs/cli`).

## Decisions taken this session

## Blockers

None.

## Notes

- **Leader lesson (D2, twice):** `progress/current.md` must be updated at every
  feature status transition, not at session close. The reviewer checks C2 on
  every pass; keep current.md in lockstep with `feature_list.json` — update both
  in the same breath.

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
