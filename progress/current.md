# Current session

> Working memory for the **active** session. Written *while* working, not at the
> end. On session close, move the summary into `progress/history.md` (with the
> effort record) and reset this file to the template below.

**Feature:** — none active —
**Status:** idle
**Session started:** —

## Goal

Next up: feature `infra_compose` (id 4, phase 4) — `docker-compose.infra.yml`
with MySQL (3 databases), MongoDB, Kafka (KRaft), Redpanda Console, NATS (core),
n8n, OTel Collector, Jaeger, Prometheus, Grafana; SonarQube behind a profile.
Then `messaging_topology` (id 5) creates the topics and DLQs from `asyncapi.yaml`.

## Decisions taken this session

## Blockers

None.

## Notes

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
