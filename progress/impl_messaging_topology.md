# impl_messaging_topology

Feature 5 (`messaging_topology`), phase 4. Rejected once at review
(`progress/review_messaging_topology.md`), defects fixed, re-verified. Status
set to `in_review`.

## What was built

The topic list is **never retyped**. `infra/kafka/create-topics.sh` parses
`specs/shared/asyncapi.yaml` with `yq` at run time, selecting every channel
whose `bindings.kafka.topic` is set (the spec's own structural signal for
"this is a Kafka channel" — every NATS RPC channel in the spec has no
`bindings.kafka` block at all, so it is excluded without any string-matching
on names). If the spec cannot be read, cannot be parsed, or yields zero
kafka-bound channels, the script exits non-zero with a `FATAL:` message and
creates nothing.

Files created/changed:

- `infra/kafka/create-topics.sh` — the single implementation. Derives the
  topic list from the spec, creates each idempotently
  (`kafka-topics.sh --create --if-not-exists`), then asserts the broker's
  topic set (Kafka's own `__`-prefixed internal topics excluded, nothing
  else) is **exactly** the derived set, and separately verifies partition
  count and replication factor per topic (see "What the review caught"
  below). Partitions default to 6, replication factor 1 (single-node dev
  broker); the script's header comment explains why 6 partitions cannot
  break the per-order ordering guarantee: all facts about one order are
  produced with `correlationId` (the order id) as the Kafka key, so Kafka's
  default hash partitioner always routes them to the same partition
  regardless of partition count.
- `infra/kafka/Dockerfile` — `apache/kafka:4.3.1` (same tag as the `kafka`
  service in `docker-compose.infra.yml`) plus a single pinned `yq` binary
  copied in from `mikefarah/yq:4.47.2`, exactly the pattern
  `infra/otel-collector/Dockerfile` used for busybox. Built as
  `otc-kafka-init:4.3.1`, `pull_policy: build`.
- `docker-compose.infra.yml` — `kafka-init` service: one-shot,
  `depends_on: kafka: condition: service_healthy`, `restart: "no"`, mounts
  `specs/shared/asyncapi.yaml` read-only, talks to the broker on the internal
  listener `kafka:29092`. Carries `KAFKA_TOPIC_PARTITIONS` /
  `KAFKA_TOPIC_REPLICATION_FACTOR` env vars (defaults `6` / `1`).
- `package.json` — script `"kafka:topics": "docker compose -f
  docker-compose.infra.yml run --rm kafka-init"`. This runs the **same**
  container/script the compose file uses — no second copy of the logic.
- `.env.example` — `KAFKA_TOPIC_PARTITIONS` and
  `KAFKA_TOPIC_REPLICATION_FACTOR` documented in the Kafka block, each with a
  one-line comment (partitions: safe to raise because every fact is keyed by
  `correlationId`; replication factor: must stay `1` on a single-node
  broker).

## R<n> traceability

This feature has no dedicated EARS requirements in `specs/shared/`
(`sdd: false`, no `specs/messaging_topology/`); it operationalizes the fact
topics that `asyncapi.yaml` itself defines (R11–R18 govern the envelope and
ordering those topics carry, but this feature is the compose/infra layer,
not a domain layer with unit tests). No test-matrix row applies.

## What the review caught, and what changed

The first submission was rejected on 4 defects (`progress/review_messaging_topology.md`).
D2 (stale `progress/current.md`) was the leader's, not this feature's, and is
not addressed here.

- **D1 (required) — `.env.example` regression.** `docker-compose.infra.yml`
  introduced `KAFKA_TOPIC_PARTITIONS` / `KAFKA_TOPIC_REPLICATION_FACTOR` but
  `.env.example` never gained them, silently breaking feature 4's closed
  "`.env.example` complete" acceptance criterion. **Fixed:** both vars added
  to the Kafka block of `.env.example` with the reasoning comments the
  reviewer asked for (partitions safe to raise because facts are keyed by
  `correlationId`; RF must stay 1 — single-node broker).
- **D3 (advisory) — asymmetric verify comparison.** The exact-match check
  compared an `ACTUAL` list filtered to `^otc\.` against an `EXPECTED` list
  with no such filter — comparable only by coincidence, because every topic
  in today's spec happens to start `otc.`. **Fixed:** both sides are now
  derived symmetrically. `EXPECTED` is `$TOPICS` (the spec, unfiltered by any
  literal prefix); `ACTUAL` is the broker's topic list with only Kafka's own
  `__`-prefixed internal topics excluded (a structural Kafka convention, not
  an application-namespace guess). A spec-declared topic under any prefix
  would now be compared correctly.
- **D4 (advisory) — "verified" over-claimed; shape drift passed silently.**
  `--create --if-not-exists` is a no-op against a topic that exists with the
  wrong partition count/replication factor, and the old final check compared
  names only, so `OK: ... verified` printed even when a topic had drifted to
  1 partition. **Fixed:** added a second verification pass that
  `--describe`s every spec topic and compares its actual partition count and
  replication factor against `$PARTITIONS` / `$REPLICATION_FACTOR`. Any
  mismatch is collected and reported as a `FATAL` with the affected topic
  name(s), and the script explicitly refuses to auto-alter the drifted
  topic (repartitioning would silently reorder a saga's in-flight per-order
  facts; RF changes need a planned reassignment) — it tells the operator to
  intervene manually. Reproduced live in re-verification below.

## Re-verification — real output, against the running stack (this session)

**1. Fresh `kafka-init` run, then a second run — both exit 0 (idempotency
intact)**
```
$ docker compose -f docker-compose.infra.yml run --rm kafka-init
...
OK: all 6 spec-derived Kafka topic(s) verified present on the broker with the
correct name, partition count (6) and replication factor (1), and no others.
EXIT=0

$ docker compose -f docker-compose.infra.yml run --rm kafka-init   # 2nd run
...
Ensuring topic exists: otc.orders.facts.v1        (x6, no "Created topic" lines)
OK: all 6 spec-derived Kafka topic(s) verified present ...
EXIT=0
```

**2. All 6 topics, exact match, listed from the host on 9092**
```
$ docker run --rm --network host apache/kafka:4.3.1 \
    /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list | sort
__consumer_offsets
otc.billing.facts.v1
otc.billing.facts.v1.dlq
otc.fulfillment.facts.v1
otc.fulfillment.facts.v1.dlq
otc.orders.facts.v1
otc.orders.facts.v1.dlq
```
(Used a throwaway `apache/kafka:4.3.1` container on `--network host` to speak
to the broker's `EXTERNAL` listener at `localhost:9092`, i.e. genuinely from
the host, not from inside `otc-net`.)

**3. Reproduced the reviewer's D4 probe myself — drift now fails loudly**

Induced drift: deleted `otc.billing.facts.v1.dlq` and recreated it with 1
partition instead of 6:
```
$ docker exec otc-kafka kafka-topics.sh --describe --topic otc.billing.facts.v1.dlq
PartitionCount: 1  ReplicationFactor: 1
```
Ran verification against the real spec:
```
$ docker compose -f docker-compose.infra.yml run --rm kafka-init
...
DRIFT: otc.billing.facts.v1.dlq has partitions=1 replication=1, expected partitions=6 replication=1
FATAL: the following topic(s) exist with the wrong shape (partition count and/or replication factor): otc.billing.facts.v1.dlq
This script never auto-alters an existing topic's shape — repartitioning
changes key->partition routing (would silently reorder a saga's in-flight
per-order facts) and replication-factor changes need a planned reassignment.
Fix manually: on a dev stack, delete and let this script recreate the topic
(kafka-topics.sh --delete --topic <name>, then re-run); in a real environment,
plan a kafka-reassign-partitions run instead.
EXIT=1
```
This is the exact gap the reviewer found in the prior submission (`EXIT_DRIFT=0`
there); it now fails, loudly, naming the topic, and refusing to self-heal.

Restored: deleted the drifted topic and let `kafka-init` recreate it at the
correct shape:
```
$ docker exec otc-kafka kafka-topics.sh --delete --topic otc.billing.facts.v1.dlq
$ docker compose -f docker-compose.infra.yml run --rm kafka-init
...
OK: all 6 spec-derived Kafka topic(s) verified present on the broker with the
correct name, partition count (6) and replication factor (1), and no others.
EXIT=0
```

**4. `.env.example` carries both new vars, and overriding them genuinely
changes what a fresh run creates**
```
$ grep -n "KAFKA_TOPIC_PARTITIONS\|KAFKA_TOPIC_REPLICATION_FACTOR" .env.example
63:KAFKA_TOPIC_PARTITIONS=6
67:KAFKA_TOPIC_REPLICATION_FACTOR=1
```
Deleted all 6 topics from an otherwise-untouched broker, then ran a fresh
creation with an env override:
```
$ docker exec otc-kafka kafka-topics.sh --delete --topic <each of the 6>
$ KAFKA_TOPIC_PARTITIONS=3 docker compose -f docker-compose.infra.yml run --rm kafka-init
...
Created topic otc.orders.facts.v1.
...
OK: all 6 spec-derived Kafka topic(s) verified present on the broker with the
correct name, partition count (3) and replication factor (1), and no others.
EXIT=0

$ docker exec otc-kafka kafka-topics.sh --describe --topic otc.orders.facts.v1 | head -1
Topic: otc.orders.facts.v1  PartitionCount: 3  ReplicationFactor: 1
```
Confirmed independently on the broker, not just from the script's own claim.
Then restored the default: deleted all 6 again, re-ran `kafka-init` with no
override, confirmed 6 partitions on the broker again (see §1's output).

**5. `./init.sh` exits 0; all 10 long-running services healthy**
```
$ docker ps --format '{{.Names}}\t{{.Status}}'
otc-grafana          Up ... (healthy)
otc-jaeger           Up ... (healthy)
otc-kafka-console    Up ... (healthy)
otc-kafka            Up ... (healthy)
otc-mongodb          Up ... (healthy)
otc-mysql            Up ... (healthy)
otc-n8n              Up ... (healthy)
otc-nats             Up ... (healthy)
otc-otel-collector   Up ... (healthy)
otc-prometheus       Up ... (healthy)

$ docker ps -a --filter name=otc-kafka-init
otc-kafka-init  Exited (0)   # one-shot job, correctly not "running"

$ ./init.sh
...
══ init.sh: environment and state are coherent ══
INIT_EXIT=0
```
Only the two expected WARNs (12 uncommitted mid-session changes; no test
script yet — `monorepo_scaffold` still `pending`).

Stack left running.

## Deviations / notes (unchanged from the original submission)

- No `specs/messaging_topology/` directory exists and the feature is
  `sdd: false`, so no domain unit tests were written — this is
  infrastructure-only work per the acceptance criteria (no domain/
  application code touched).
- The NATS side of the acceptance ("...and the NATS subject registry" in the
  feature title) is **not** implemented, per the reviewer's own accepted
  reasoning: NATS core has no server-side topology to provision, and
  `specs/shared/asyncapi.yaml` already *is* the subject registry (14 request
  + 14 reply channels under `servers.rpcTransport`). `create-topics.sh`'s
  selector (`bindings.kafka.topic`) structurally excludes every RPC channel
  for exactly this reason.
- Partition count (6) is a judgment call, documented inline in the script's
  header comment; it is env-overridable (`KAFKA_TOPIC_PARTITIONS`) without
  touching the script, and now also documented in `.env.example`.
- Carry-over noted by the reviewer for the leader: once Vitest exists
  (feature 6, `monorepo_scaffold`), the spec-to-topology derivation deserves
  one real Testcontainers-Kafka integration test so the property is defended
  by CI, not by a reviewer's manual probes.
