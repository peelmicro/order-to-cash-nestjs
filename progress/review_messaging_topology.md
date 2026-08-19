# review_messaging_topology

**Feature:** `messaging_topology` (id 5, phase 4) — `sdd: false`
**Reviewer:** reviewer agent
**Date:** 2026-08-19

**Verdict: REJECTED** — 0 blocking, 2 required minor defects, 2 advisories.
Status returned to `in_progress`.

> The engineering core of this feature is **sound and independently proven**:
> the topic list really is derived from `specs/shared/asyncapi.yaml` (I proved it
> by pointing the same image at an altered copy of the spec and watching the
> created names change), every failure path fails loudly, the topology is
> idempotent, survives `down`/`up`, and the container and the pnpm script share
> one implementation. Nothing here needs redesign.
>
> It is rejected on two small, concrete regressions of invariants this repo has
> already closed a feature on. Both are one-line fixes. Re-review should be fast.

---

## 1. CHECKPOINTS walked

C1, C2 and C5 apply. **C3, C4 and C6 do not apply** — no application code, no
`packages/`, no test runner and no `sdd: true` feature exists yet (phase 5+).
C7 partially applies and is noted.

### C1 — The harness is complete

- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer.
- [x] Every agent definition declares its model (verified again via `init.sh` §2).
- [x] `./init.sh` exits 0 — run by me, `INIT_EXIT=0`, only the two expected WARNs
      (uncommitted mid-session changes; no test script yet).

### C2 — State is coherent

- [x] At most one feature `in_progress` — none is; `messaging_topology` is `in_review`.
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it — vacuously true;
      features 1–4 are harness/spec/infra, verified by `init.sh` and by live probing.
- [ ] **`progress/current.md` describes the active session** — **FAILS.** It still
      says `**Feature:** infra_compose (id 4, phase 4)` /
      `**Status:** in_progress — rejected at review, fixes in flight`. Feature 4 is
      `done` and feature 5 is `in_review`. This is the *same* box that failed last
      review (D7 there). See defect **D2**.
- [x] Every `blocked` feature records why — none blocked.

### C5 — The session closed cleanly

- [x] No suspicious untracked files. `git status --short` shows only the expected
      phase-4 artifacts; the implementer's `.verify-tmp/` really is gone. My own
      probe copies were made inside containers (`docker cp`) and in the scratchpad,
      never in the repo, and are deleted. `specs/shared/asyncapi.yaml` is untouched
      (`git status` shows no modification).
- [ ] **`progress/history.md` has an entry for the feature just finished, including
      its effort record** — not applicable at rejection; the entry is written by the
      reviewer on approval. Nothing to add yet.
- [x] `feature_list.json` reflects the true state of every feature touched
      (set back to `in_progress` by this review).
- [x] The human has been told what was done and how to test it manually —
      `progress/impl_messaging_topology.md` doubles as a runnable recipe.
- [x] **Claude did not commit.** `git log` head is still `cf795db docs(spec): ...`.

### C7 — Trilogy reusability (partial, noted)

- [x] `specs/shared/` untouched by this feature and still stack-agnostic — and this
      feature makes it *load-bearing*, which is exactly the property #8 and #9 need.
      `infra/kafka/create-topics.sh` is a plain POSIX-ish bash script with `yq`; #8
      and #9 can reuse it byte-for-byte.

---

## 2. Requirement / acceptance traceability

`sdd: false`, no `specs/messaging_topology/`, so C6 does not apply and there are no
`R<n>` ids owned by this feature. The implementer's claim on this point is correct.
The three `feature_list.json` acceptance items are the contract, and each was
verified by me independently:

| Acceptance item | Verified how | Result |
|---|---|---|
| 3 fact topics + 3 `.dlq` topics created idempotently | deleted all 6 topics, ran `pnpm kafka:topics` → 6 × `Created topic`; ran again → 0 × `Created topic`, exit 0; `docker compose up -d` a second time on a live stack re-ran `kafka-init` → exit 0 | PASS |
| topics match `asyncapi.yaml` exactly | independent derivation with Python/PyYAML (not the script's `yq`) over `specs/shared/asyncapi.yaml` → the same 6 names, and set-equal to what the broker reports | PASS |
| Redpanda Console lists all 6 | `curl http://localhost:8080/api/topics` from the host → all 6 + `__consumer_offsets` | PASS |

---

## 3. Independent verification (real output, my own runs)

### 3.1 The design rule — topic list derived from the spec, not hardcoded

**Grep for a fallback list — clean.** Across the whole repo excluding `progress/`
and `specs/`, the strings `otc.orders` / `otc.fulfillment` / `otc.billing` appear
**nowhere** in the implementation. The only `.dlq` occurrences are prose:
`feature_list.json:83`, `feature_list.json:378`, `docker-compose.infra.yml:130`
(a comment). There is no default value, no fallback array, no commented-out list.

**Behavioural proof — the same image against an altered *copy* of the spec.** I did
not edit `specs/shared/asyncapi.yaml`. I built a copy with
`otc.orders.facts.v1 → zzreviewprobe.alpha.v9` and
`otc.billing.facts.v1 → zzreviewprobe.beta.v9`, injected it with `docker cp`
(Docker Desktop refuses bind mounts from outside its shared paths — the
implementer's note about this is accurate), and ran `otc-kafka-init:4.3.1`:

```
Derived 6 Kafka topic(s) from the spec:
  - zzreviewprobe.alpha.v9
  - otc.fulfillment.facts.v1
  - zzreviewprobe.beta.v9
  - zzreviewprobe.alpha.v9.dlq
  - otc.fulfillment.facts.v1.dlq
  - zzreviewprobe.beta.v9.dlq

Ensuring topic exists: zzreviewprobe.alpha.v9
Created topic zzreviewprobe.alpha.v9.
...
FATAL: the broker's otc.* topic set does not match the spec exactly.
EXIT_A=1
```

The created names followed the copy. **Derivation is real.** The 4 probe topics were
deleted afterwards and the broker re-verified (see §3.6).

**Kafka vs NATS discrimination is structural, not name-based.** The selector is
`yq '.channels[] | select(.bindings.kafka.topic != null) | .bindings.kafka.topic'`
(`infra/kafka/create-topics.sh:51`). I confirmed against the spec itself: 34
channels, 6 with a `bindings.kafka` block, 28 without; `servers.factStream.protocol`
= `kafka`, `servers.rpcTransport.protocol` = `nats`. No channel name or address
is pattern-matched. Removing the `bindings` blocks changes the outcome (§3.3,
case B), which is what proves the signal is really the binding.

### 3.2 Topics listed **from the host on 9092**, with partition/replication shape

I could not use a `--network host` helper container in this environment, so I spoke
the Kafka wire protocol directly from the host — a raw TCP `Metadata` v0 request to
`localhost:9092`. This is the strongest possible form of "from the host":

```
brokers (as advertised on this listener): [(1, 'localhost', 9092)]
__consumer_offsets          partitions=50  replication=1  err=0
otc.billing.facts.v1        partitions=6   replication=1  err=0
otc.billing.facts.v1.dlq    partitions=6   replication=1  err=0
otc.fulfillment.facts.v1    partitions=6   replication=1  err=0
otc.fulfillment.facts.v1.dlq partitions=6  replication=1  err=0
otc.orders.facts.v1         partitions=6   replication=1  err=0
otc.orders.facts.v1.dlq     partitions=6   replication=1  err=0
```

Exactly the 6 spec names, no more; 6 partitions, RF 1 on every one.

### 3.3 Loud failure — every path tested by me, not read

| Case | Observed | Exit |
|---|---|---|
| Spec file missing | `FATAL: asyncapi spec not found at /tmp/does-not-exist.yaml — refusing to fall back to a hardcoded topic list.` | 1 |
| Spec is unparseable YAML | `FATAL: could not parse ... with yq: Error: bad file ...: yaml: line 1: did not find expected ',' or ']'` | 1 |
| Spec parses but every `bindings.kafka` stripped | `FATAL: parsed ... but found zero channels with a bindings.kafka.topic — refusing to proceed with an empty topology.` | 1 |
| **A topic genuinely fails to create** (`KAFKA_TOPIC_REPLICATION_FACTOR=3` on a single-node broker) | `Error while executing topic command : Unable to replicate the partition 3 time(s)...` and the script stops on the *first* failure (`set -euo pipefail`) | 1 |
| Broker unreachable (`no-such-broker:29092`) | `No resolvable bootstrap urls given in bootstrap.servers`, stops immediately | 1 |
| Broker topology drifts from the spec | `FATAL: the broker's otc.* topic set does not match the spec exactly.` + expected/actual diff | 1 |

No topic was created in any of the first three cases. The loud-failure requirement
is **met** — with the one caveat in advisory **D4**.

### 3.4 Idempotency

- Fresh creation from an empty broker: I deleted all 6 topics, then `pnpm kafka:topics`
  → 6 × `Created topic`, `OK: all 6 ... verified present`, exit 0.
- Immediate re-run: 6 × `Ensuring topic exists`, **zero** `Created topic`, exit 0.
- `docker compose up -d` on an already-running stack: `otc-kafka-init Started`,
  `docker wait otc-kafka-init` → `0`. Repeat runs are safe.

### 3.5 Survives `down` + `up -d`

`docker compose -f docker-compose.infra.yml down` (network + all containers removed),
then `up -d`: `docker wait otc-kafka-init` → `0`, log shows **no** `Created topic`
lines (the topics were still there from the `kafka_data` volume), and the host-side
metadata probe returned the same 6 topics at 6 partitions. Feature 4's D1 fix
(`KAFKA_LOG_DIRS: /var/lib/kafka/data` matching the mount) still holds.

### 3.6 One implementation, two callers

`package.json` `"kafka:topics": "docker compose -f docker-compose.infra.yml run --rm kafka-init"`
runs the *same* compose service, hence the same `otc-kafka-init:4.3.1` image, hence
the same `/usr/local/bin/create-topics.sh`. There is exactly one copy of the logic
in the repo (`infra/kafka/create-topics.sh`, 102 lines). `docker compose run` honours
`depends_on: kafka: condition: service_healthy` — I watched
`Container otc-kafka Waiting → Healthy` before the job started. **No duplication.**

### 3.7 Image pinning

`infra/kafka/Dockerfile` uses `FROM mikefarah/yq:4.47.2` and `FROM apache/kafka:4.3.1`
— both exact. `grep -n latest` over `docker-compose.infra.yml` and both Dockerfiles
returns nothing. All 12 `image:` lines in the compose file carry an exact tag.
`pull_policy: build` is present on `kafka-init` (feature 4's D4 lesson carried over
correctly). The `yq` binary in the built image reports `v4.47.2`, and the container
drops back to `USER appuser` after the root-owned `COPY`/`chmod` — good hygiene.

### 3.8 Partition count and ordering

6 partitions, RF 1. The reasoning **is** recorded, at `infra/kafka/create-topics.sh:18–27`,
and it is correct: all facts about one order are produced with `correlationId` as the
Kafka key, so the default hash partitioner pins them to one partition regardless of
partition count. I cross-checked the premise against the spec rather than the script —
`specs/shared/asyncapi.yaml` states `Partition key: correlationId (the order id)` on
`ordersFacts` (line 102) and `fulfillmentFacts` (line 129), and `billingFacts`
(lines 156–159) requires `payment.received.v1` and `credit.released.v1` on the same
partition key in one transaction. **6 partitions cannot break the saga's ordering
guarantee.** RF 1 is the only legal value on a single-node broker — proven by the
RF=3 failure in §3.3. (Wording nit, not a defect: line 23 reads
"per asyncapi.yaml's default Kafka partitioner uses a hash of the key" — a garbled
splice of two clauses. Worth tidying since #8/#9 copy this file.)

### 3.9 Feature-4 regression sweep (the compose file was edited)

| Property | Check | Result |
|---|---|---|
| NATS core-only, no JetStream | `curl :8222/varz` → `jetstream: {}` (empty — not enabled), version 2.14.5 | intact |
| Jaeger OTLP not on the host | `docker port otc-jaeger` → only `16686`; `otel-collector` owns 4317/4318 | intact |
| SonarQube profile-gated | not present in `docker ps -a` after `up -d`; `profiles: ["sonar"]` still on the service | intact |
| No `latest` anywhere | grep clean | intact |
| All infra services healthy | 10/10 `Up (healthy)`, `otc-kafka-init` `Exited (0)` | intact |
| D1/D2/D3/D5 fixes from the last review | `KAFKA_LOG_DIRS` + matching mount, SonarQube body assert, `/-/ready` + `/healthz/readiness`, `.sh` MySQL init | intact |
| **`.env.example` complete** | 2 new `${VAR}` defaults undocumented | **REGRESSED — see D1** |

---

## 4. Defects

### D1 — REQUIRED (minor): the two new tunables are missing from `.env.example`

**Files:** `docker-compose.infra.yml` lines **149–150**; `.env.example` (Kafka block
ends at line **55**, `KAFKA_CLUSTER_ID`).

This feature introduced two new environment knobs:

```yaml
149:      KAFKA_TOPIC_PARTITIONS: ${KAFKA_TOPIC_PARTITIONS:-6}
150:      KAFKA_TOPIC_REPLICATION_FACTOR: ${KAFKA_TOPIC_REPLICATION_FACTOR:-1}
```

Neither appears in `.env.example`. I diffed mechanically — every `${VAR}` referenced
in the compose file against every key defined in `.env.example`:

```
missing: ['KAFKA_TOPIC_PARTITIONS', 'KAFKA_TOPIC_REPLICATION_FACTOR']
```

**Why it matters.** `.env.example complete` is a closed acceptance criterion of
feature 4 (`feature_list.json`), and the previous review verified it explicitly
(`progress/review_infra_compose.md` §4.11). This feature silently made it false. It
is also the file #8 and #9 copy first: the partition count is the single most
interesting knob this feature adds, and the *only* place a reader would look for it
is the one place it is not written down. Nothing breaks at runtime — the `:-6` /
`:-1` defaults hold — which is precisely why it would never be noticed later.

**Required fix.** Add both to the Kafka block of `.env.example` (after line 55), with
a one-line comment on each: partitions = future consumer-group parallelism, safe
because facts are keyed by `correlationId`; replication factor must stay 1 on a
single-node broker.

### D2 — REQUIRED (minor, fails a C2 box): `progress/current.md` is a leftover, again

**File:** `progress/current.md`, lines 7–8.

```
**Feature:** `infra_compose` (id 4, phase 4)
**Status:** in_progress — rejected at review, fixes in flight
```

Feature 4 has been `done` since the previous review; feature 5 has been built and
submitted. The file describes neither the active session nor the template.

**Why it matters.** `CHECKPOINTS.md` C2 says `current.md` must describe the active
session "never leftovers from a previous session", and instructs the reviewer to
refuse the close while any applicable box is empty. This is the second consecutive
review at which this exact box fails (it was D7 last time). A working-memory file
that contradicts `feature_list.json` is worse than an empty one: the next session
reads it first. **Ownership: the leader, not the implementer** — but the box is part
of this close and cannot be waived.

**Required fix.** Point `current.md` at `messaging_topology` with its real status, or
reset it to the template.

### D3 — ADVISORY (not blocking): the verify step compares a filtered actual against an unfiltered expected

**File:** `infra/kafka/create-topics.sh`, lines **89–92**.

```bash
ACTUAL="$("$KAFKA_TOPICS_BIN" ... --list | grep '^otc\.' | sort || true)"
EXPECTED="$(printf '%s\n' "$TOPICS" | sort)"
if [ "$ACTUAL" != "$EXPECTED" ]; then
```

`ACTUAL` is narrowed to the `otc.` namespace; `EXPECTED` is not narrowed at all. The
two sides are therefore only comparable while every Kafka topic in the spec happens
to start with `otc.`. If the spec ever adds a fact topic under another prefix, this
script will create it correctly and then **fail anyway**, reporting a mismatch that
does not exist. My altered-spec run in §3.1 is exactly that shape.

`^otc\.` is also the one namespace literal in the implementation. It is **not** a
fallback topic list — it cannot create anything, and the grep alone can never
substitute for the spec — so it does not violate the no-hardcoding rule. But it is a
literal that will be copy-pasted into #8 and #9.

**Suggested fix (cheap).** Derive the prefix from the spec, e.g. the longest common
dotted prefix of `$TOPICS`, or filter `ACTUAL` by membership in `$TOPICS` plus a
separate "unexpected `otc.*` leftovers" check. Not blocking; the failure direction is
loud, never silent.

### D4 — ADVISORY (not blocking): "verified" over-claims — shape drift passes silently

**File:** `infra/kafka/create-topics.sh`, lines **75–79** and **101**.

`--create --if-not-exists` is a no-op when the name exists, whatever its partition
count or replication factor, and the final check compares **names only**. I proved
the gap: I recreated `otc.billing.facts.v1.dlq` with **1** partition, then ran
`kafka-init` against the real spec:

```
OK: all 6 spec-derived Kafka topic(s) verified present on the broker, and no others.
EXIT_DRIFT=0
otc.billing.facts.v1.dlq   partitions=1   replication=1
```

The header had just printed `partitions: 6`, and the script reported success. A
consumer group sized for 6 partitions would quietly get 1.

**Why it is only advisory.** "Ensure the topic exists" is a defensible idempotency
contract, this only bites if a human hand-creates a topic, and it is a fresh-stack
non-issue. But `OK: ... verified` is a stronger claim than the code makes good.
Either narrow the wording, or compare `--describe` output (partition count) as well
as the name set. Recommend fixing while the file is open, since #8 and #9 inherit it.

**State left clean:** the drifted topic was deleted and recreated through
`kafka-init` itself; the broker is back to 6 topics × 6 partitions × RF 1 (§3.2
output re-run and confirmed after the probe).

---

## 5. Notes on the deviations the implementer flagged

- **"NATS subject registry" not implemented.** Accepted. The feature's own
  `acceptance` list in `feature_list.json` names only the 6 Kafka topics; NATS core
  has no server-side topology to provision, and `specs/shared/asyncapi.yaml` already
  *is* the subject registry (14 request channels + 14 reply channels under
  `servers.rpcTransport`). The selector excludes them structurally rather than by
  name, which is the right reason. Nothing to change.
- **No unit tests.** Accepted for this feature: `sdd: false`, no `specs/messaging_topology/`,
  no test runner in the repo yet (feature 6 `monorepo_scaffold` is still `pending`),
  and the artifact is a shell script in a container. The behavioural probes in §3 are
  the substitute, and they are reproducible from this document. **Carry-over for the
  leader:** once Vitest exists, the spec→topology derivation deserves one real
  integration test (Testcontainers Kafka + this image) so the property is defended by
  CI and not by a reviewer's afternoon.
- **`.verify-tmp/` cleanup.** Confirmed gone; `git status` is clean of it and
  `specs/shared/asyncapi.yaml` is unmodified.

---

## 6. What must change before re-review

1. **D1** — add `KAFKA_TOPIC_PARTITIONS` and `KAFKA_TOPIC_REPLICATION_FACTOR` to the
   Kafka block of `.env.example`, each with a one-line comment.
2. **D2** — update `progress/current.md` so it describes the active session
   (`messaging_topology`) or is reset to its template. *(Leader's file.)*
3. **D3 / D4** — recommended, not required. If addressed, say so; if deliberately
   declined, say why in `progress/impl_messaging_topology.md` and it will be accepted.

**Not required, and please do not do it:** nothing about the derivation, the failure
handling, the Dockerfile, the compose wiring or the pnpm script needs to change. Do
not "improve" `create-topics.sh` beyond D3/D4 — it passed every probe I could design.

**Required proof on re-submission:** the mechanical `${VAR}`-vs-`.env.example` diff
coming back empty. Everything else in §3 already stands and does not need re-running.

---

# Second pass — 2026-08-19

**Verdict: APPROVED** — all 4 first-pass defects fixed and independently
re-proved against the running stack. 0 defects remain.

## Defect-by-defect confirmation (my own probes, not the implementer's transcript)

### D1 — FIXED. `.env.example` carries both tunables with reasoned comments

`.env.example:63` `KAFKA_TOPIC_PARTITIONS=6` (comment: safe because facts are
keyed by `correlationId`, ordering never depends on the count) and
`.env.example:67` `KAFKA_TOPIC_REPLICATION_FACTOR=1` (comment: MUST stay 1 on a
single-node broker). The required mechanical proof came back clean:

```
compose ${VAR} refs: 36
missing from .env.example: []
```

Feature 4's "`.env.example` complete" acceptance criterion is true again.

### D2 — FIXED. `progress/current.md` describes the active session

Lines 7–9 now read `Feature: messaging_topology (id 5, phase 4)` /
`Status: in_progress — second review pass pending (D1 + 2 advisories being fixed)` /
`Session started: 2026-08-18`, with real decisions and a "leader lesson" note on
the double D2/D7 recurrence. C2's failing box now passes. (Wording nit, not a
defect: it says `in_progress` where `feature_list.json` said `in_review` at
probe time — it truthfully describes the mid-fix moment it was written in, and
the leader resets this file at session close.)

### D3 — FIXED. The verify comparison is symmetric

`infra/kafka/create-topics.sh:97–98`: `ACTUAL` is the broker list filtered only
by `grep -v '^__'` (Kafka's own internal-topic convention, structural, not an
application namespace); `EXPECTED` is `$TOPICS` verbatim from the spec. The
`^otc\.` literal is gone — `grep -n otc create-topics.sh` now matches only the
`== otc kafka topology ==` banner (line 33) and the comment explaining *why*
namespace filtering was removed (line 94). Neither can create, select or filter
a topic. A spec-declared topic under any prefix is now compared correctly.

### D4 — FIXED. Shape drift fails loudly; no auto-alter. Re-ran my own probe

A second verification pass (`create-topics.sh:109–134`) `--describe`s every spec
topic and compares `PartitionCount` / `ReplicationFactor` against the configured
values, collecting all drifted topics and exiting 1 with names. Live probe, my
own hands:

1. Deleted `otc.billing.facts.v1.dlq`, recreated it with **1** partition
   (broker confirmed `PartitionCount: 1`).
2. Ran `kafka-init` against the real spec:
   ```
   DRIFT: otc.billing.facts.v1.dlq has partitions=1 replication=1, expected partitions=6 replication=1
   FATAL: the following topic(s) exist with the wrong shape (partition count and/or replication factor): otc.billing.facts.v1.dlq
   DRIFT_EXIT=1
   ```
3. Confirmed **no auto-alter**: the topic still described as `PartitionCount: 1`
   after the failing run.
4. Restored: deleted the drifted topic, re-ran `kafka-init` → `Created topic
   otc.billing.facts.v1.dlq.` … `OK: all 6 spec-derived Kafka topic(s) verified
   present on the broker with the correct name, partition count (6) and
   replication factor (1), and no others.` → exit 0; broker re-describes
   `PartitionCount: 6 ReplicationFactor: 1`.

This is exactly the gap that returned `EXIT_DRIFT=0` on the first pass; it is
now closed. The success message ("verified … correct name, partition count …
and replication factor") no longer over-claims — the code makes good on it.

## Regression sweep — nothing moved backwards

| Check | Result |
|---|---|
| 6 topics, exact spec match, **from the host on 9092** (`--network host` describe) | `otc.{orders,fulfillment,billing}.facts.v1{,.dlq}` — 6 partitions, RF 1 each; only `__consumer_offsets` besides |
| Idempotent second run | run 1 exit 0; run 2: **0** `Created topic` lines, exit 0 |
| Derivation from spec, no hardcoded list | repo-wide grep for `otc.orders|otc.fulfillment|otc.billing|.dlq` outside `specs/`+`progress/`: only prose (`feature_list.json:83,378`, compose comment line 130). No fallback array anywhere |
| All 10 long-running services | `Up (healthy)` × 10; `otc-kafka-init` `Exited (0)` |
| `./init.sh` | `INIT_EXIT=0`, only the expected WARNs (uncommitted mid-session changes; no test script yet) |
| Broker final state | left correct: 6 topics × 6 partitions × RF 1; stack left running |

## CHECKPOINTS delta from first pass

- C2 "`progress/current.md` describes the active session" — **[x]** (was [ ]).
- C5 "`progress/history.md` has an entry incl. effort record" — **[x]**, written
  by this approval.
- All other first-pass boxes re-affirmed unchanged.

## Close-out

- `feature_list.json`: `messaging_topology` → `done`.
- `progress/history.md`: entry appended with effort record (1 session, ~3h
  wall-clock, two review passes, one session interruption).
- Carry-over for the leader (unchanged): once Vitest exists (feature 6), add one
  Testcontainers-Kafka integration test for the spec→topology derivation.
