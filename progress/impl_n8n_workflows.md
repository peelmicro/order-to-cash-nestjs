# impl_n8n_workflows — feature 33 (phase 20)

`sdd: false`. Spec: `specs/shared/n8n-workflows.md`. No `R<n>` is satisfied by this
feature (the spec's own §9/§1 say so explicitly) — traceability below is
"what was verified", not test-matrix rows.

## What was built

**Four committed workflows**, `n8n/workflows/*.json` (hand-authored, minimal
shape: `id`/`name`/`nodes`/`connections`/`active`/`settings` — the exact
shape n8n's own `import:workflow` accepts and `export:workflow` round-trips
back to, once stripped of instance bookkeeping):

| File | id | Trigger | Real logic |
|---|---|---|---|
| `1-order-generator.json` | `otcOrderGenerator` | `scheduleTrigger` v1.1, every 45s | one `n8n-nodes-base.code` v2 node |
| `2-payment-robot.json` | `otcPaymentRobot` | `scheduleTrigger` v1.1, every 2 min | one code node |
| `3-stock-replenishment.json` | `otcStockReplenishment` | `scheduleTrigger` v1.1, every 5 min | one code node |
| `4-burst.json` | `otcBurst` | `webhook` v2.1, `POST /webhook/otc-burst` | one code node |

Deliberate architecture choice: **one trigger + one Code node per workflow**,
not a sprawling HTTP-node chain. Each Code node does everything (login,
retry/backoff, catalogue caching via `$getWorkflowStaticData`, the `.99`
engineering, request placement, tallying) using `this.helpers.httpRequest`
directly — this is what the task brief's "prefer fewer, clearer nodes...
Code node where genuine logic is needed" asked for, and the composition/`.99`
logic is real branching arithmetic, not a good fit for expression chains.

**Tooling**:
- `scripts/import-n8n-workflows.sh` (`pnpm n8n:import`) — `docker exec
  otc-n8n n8n import:workflow --separate --input=/home/node/workflows`.
- `scripts/export-n8n-workflows.sh` (`pnpm n8n:export`) — exports each of the
  four by id, unwraps n8n's one-element-array output, and **strips instance
  identity/bookkeeping** (`shared[].project` carries the logged-in operator's
  real name and email — see Surprises) down to the same portable shape the
  files are hand-authored in. Round-trip tested: import → export produces a
  byte-identical file.
- `infra/n8n/import-workflows-on-startup.sh` + a new `n8n-init` one-shot
  service in `docker-compose.infra.yml` (same `restart: "no"` /
  `depends_on: service_healthy` shape as `kafka-init`) — auto-imports on
  every `docker compose up`, gated by `N8N_WORKFLOWS_ENABLED`.
- `n8n` + `n8n-init` now sit behind a new `"n8n"` compose profile.
  `dc:up:infra`/`dc:up:apps` pass `--profile n8n` (today's behaviour
  unchanged); new `dc:up:infra:no-n8n`/`dc:up:apps:no-n8n` omit it.
- `.env.example`: every tunable from spec §2.5/§3.4/§4.3/§5.3/§6.3
  (`N8N_WORKFLOWS_ENABLED`, `OTC_GATEWAY_URL`, `OTC_REQUEST_TIMEOUT_MS`,
  `ORDER_GENERATOR_*`, `PAYMENT_ROBOT_*`, `PAYMENT_AGE_MINUTES`,
  `STOCK_REPLENISH_*`, `BURST_*`), documented with its spec default.
  Credentials reuse the existing `GATEWAY_OPERATOR_USERNAME/PASSWORD` (the
  operator login from feature 25) rather than inventing a parallel
  `OTC_OPERATOR_*` pair the spec names but this repo never actually created.
- `README.md`: new "n8n demo workflows" section.

## Files touched

`docker-compose.infra.yml`, `package.json`, `.env.example`, `README.md`,
`n8n/workflows/{1..4}-*.json`, `scripts/import-n8n-workflows.sh`,
`scripts/export-n8n-workflows.sh`, `infra/n8n/import-workflows-on-startup.sh`.
`infra/n8n/` is new — not literally named in the task's file list, but
required to mirror `infra/kafka/`'s existing one-shot-init pattern the task
explicitly asked me to consider; flagging it rather than silently going
outside the enumerated scope.

## Verification performed (real orders, not "should work")

All four confirmed live against the real running stack (probed via a
temporary webhook-trigger clone of each workflow, since driving a real
Schedule-Trigger tick or an authenticated UI "execute" click wasn't available
non-interactively — see Surprises; the committed files use the real
Schedule/Webhook triggers, only the *test harness* swapped triggers).

**Order generator** — fired ~25 times: 21 orders accepted, several `409`
refusals (genuine `STOCK_UNAVAILABLE`), 2 correctly engineered to a `.99`
total. Real references: `ORD-000007`…`ORD-000027`. `ORD-000017` (total
36999) and `ORD-000023` (total 6999) were the `.99`-engineered ones —
confirmed via `pnpm saga:watch`: both reached `cancelled` /
`credit_rejected`, the other 19 all reached `completed`.

**Payment robot** — paid every due invoice across several runs (age filter
`PAYMENT_AGE_MINUTES=2` correctly excluded fresh invoices, e.g. one run
returned `{"paid":0,...,"message":"no invoices due"}`). Real payments:
`INV-000013` (`ORD-000012`), `INV-000024` (`ORD-000027`), `INV-000014`
(`ORD-000015`), plus more across repeated runs — **all 21 non-cancelled
orders from the generator run reached `completed`** by the end. Idempotency
(R48) verified directly: replaying `POST /invoices/{id}/payments` with the
same `paymentReference` against `INV-000013` returned `200 duplicate`
byte-for-byte, matching what the workflow's own `res.statusCode === 201 ?
'paid' : 'duplicate'` branch depends on.

**Stock replenishment** — the seeded catalogue never went low-stock under
my test volume (~50 orders total), so the "≥1 low item, group-and-top-up"
branch never fired live. Verified instead: (a) the empty-result branch
(`belowThreshold=true` → 0 items → the workflow's own graceful "no low-stock
items" message, no error), and (b) `POST /stock/replenish`'s exact request/
response shape confirmed correct via a direct curl call (`{companyCode,
lines:[{productCode,units}]} → {items:[...]}`) — the same shape
`replenishCompany()` builds and consumes. Lower confidence than the other
three on this one branch specifically; flagging it rather than claiming full
coverage.

**Burst** — fired via its real webhook (`POST /webhook/otc-burst`) with a
body override (`{"count":6,"compensationRatio":0.3}`): 3 placed
(`ORD-000028`, `ORD-000029`, `ORD-000030`), 3 refused (409), matching the
response shape the spec describes (count placed, count refused, order
references).

**§7.2 — removing n8n entirely** (the checklist item the task called out by
name): stopped and removed `otc-n8n`/`otc-n8n-init`. All 17 other containers
stayed healthy. Placed `ORD-000031` directly against the Gateway
(`POST /orders`, no n8n involved), let the saga run, then registered its
payment by hand (`POST /invoices/{id}/payments`) — it reached `completed`.
Brought `n8n`/`n8n-init` back up afterward (`--profile n8n up -d`); auto-
import ran again, sqlite state (from the shared `n8n_data` volume) survived
the down/up cycle intact.

## Left inactive

All four workflows are `active: false` in the committed JSON, confirmed at
the DB level (`active: 0`) after the final container restart, and confirmed
the n8n UI (`http://localhost:5678/`, HTTP 200) shows exactly these four —
every leftover test/probe workflow from my own verification was deleted
(direct sqlite surgery via Node's built-in `node:sqlite`, since this n8n
version has no `delete:workflow` CLI command — see Surprises). Current
order count in the system is ~31 (6 seeded + ~25 from my verification runs);
the human should reset/reseed before the Phase 24 demo recording if a
smaller list is wanted — I did not reset it myself since the task's
verification step explicitly required placing real orders.

## What I could not fully do, and why

- **True auto-*activation* on startup is not achievable cleanly** on this
  n8n version, only auto-*import*. n8n 2.36.2's CLI-level
  `publish:workflow --active=true` writes the DB flag but explicitly warns
  "changes will not take effect if n8n is running... restart n8n" — verified
  live. An init sidecar importing into an *already-running* main n8n process
  cannot make that process re-scan and register a newly-active workflow's
  triggers without restarting the main process itself, which compose has no
  clean "restart dependency B after one-shot A completes" primitive for
  (short of a fragile watch-and-kill loop I chose not to add). Per the task's
  own instruction ("if it cannot be done cleanly, say so and leave
  `n8n:import` as the documented path"), auto-import is implemented and
  auto-*activation* is not — a human toggles the switch in the UI once per
  workflow, which then persists correctly across restarts (this path IS
  clean: verified the `otcBurst` workflow's active flag survived a full
  `docker compose down`+`up` after I'd toggled it via the CLI-equivalent
  `publish`/restart sequence during testing).
- **Stock replenishment's non-empty branch** — see Verification above;
  structurally identical to the other two workflows' validated request
  pattern, and its one server-side dependency (`POST /stock/replenish`'s
  shape) was confirmed directly, but I did not watch it actually top up a
  genuinely-low product end-to-end.

## Surprises (worth a second pair of eyes)

1. **`docker-compose.infra.yml`'s n8n service has been silently running on
   SQLite, not MySQL, since it was first written.** n8n 2.36.2's `DB_TYPE`
   only accepts `sqlite`/`postgresdb` — MySQL support was dropped upstream in
   n8n's 2.0 breaking changes. Every boot logs "Invalid value for DB_TYPE...
   Falling back to default value" and n8n silently uses its own SQLite file
   in the `n8n_data` volume instead of `otc_n8n`/MySQL. Functionally this
   still works (the named volume persists fine across restarts — verified
   through several down/up cycles today), so I did not fix it: it's outside
   this feature's remit and a real fix (retarget `postgresdb`, or accept
   `sqlite` and remove the dead `MYSQL_DB_N8N`/`DB_MYSQLDB_*` wiring) is an
   architecture decision, not a workflow-authoring one. Flagged in a comment
   block directly above the `n8n:` service in `docker-compose.infra.yml` and
   here.
2. **n8n 2.x blocks `$env` access from Code nodes/expressions by default**
   (`N8N_BLOCK_ENV_ACCESS_IN_NODE` — unset means blocked, not "false means
   blocked" as the variable name alone suggests). Every `$env.X` in the
   committed workflows would silently throw "access to env vars denied"
   without `N8N_BLOCK_ENV_ACCESS_IN_NODE: "false"` on the container — added
   to `docker-compose.infra.yml`.
3. **`this.getWorkflowStaticData` doesn't exist in the external JS Task
   Runner** (`N8N_RUNNERS_ENABLED=true`, already set) — it's
   `$getWorkflowStaticData('global')`, a free function injected into the vm
   context alongside `$env`/`$input`, not a method on `this`. Caught via a
   real `TypeError` in the container logs on first live test; fixed in all
   uses.
4. **n8n's workflow JSON now requires a top-level `id`** for
   `import:workflow` to succeed (`SQLITE_CONSTRAINT: NOT NULL... workflow_
   entity.id` otherwise) — the airline-transaction-monitor sibling's example
   file doesn't have one; the retail-order-tracker one does. Followed the
   latter.
5. **No `delete:workflow` CLI command exists** in this n8n version (only
   `import`/`export`/`update`(deprecated)/`publish`/`unpublish`/`list`). My
   own test/probe workflow leftovers were removed via a direct `node:sqlite`
   script (Node 24's built-in driver, already in the container) rather than
   risk a fragile workaround — documented in case a future phase needs the
   same escape hatch.
6. **`n8n export:workflow`'s raw output embeds the logged-in operator's real
   name and email** (`shared[].project.name` = `"<Full Name> <email>"`) plus
   a project id specific to this one instance. `scripts/export-n8n-
   workflows.sh` strips all of this before writing to `n8n/workflows/` —
   committing the raw export as-is would have leaked PII into git history
   and made the file non-portable to a fresh n8n instance (including #8/#9).

## Gate results

- `docker compose -f docker-compose.infra.yml --profile n8n config -q` — valid.
- `docker compose ... config --services` with/without `--profile n8n` —
  correctly includes/excludes `n8n`, `n8n-init`.
- `pnpm n8n:import` / `pnpm n8n:export` — both run clean against the live
  container; round-trip is a no-op diff.
- `n8n-init` one-shot container — exits 0, idempotent (re-ran multiple
  times), honours `N8N_WORKFLOWS_ENABLED=false` (verified: prints "skipping
  import, nothing changed" and exits 0 without touching the DB).
- `./init.sh` — still exits 0 (green: 38/41 features done, 8 uncommitted
  changes flagged as expected mid-session).
- Did not run `pnpm quality` — no TypeScript/application source was touched
  by this feature (constraint: `n8n/**`, `scripts/**`,
  `docker-compose.infra.yml`, root `package.json`, `.env.example`,
  `README.md` only), so there is nothing for lint/typecheck/vitest to cover;
  `pnpm test:coverage` was already green going in and this feature adds no
  `.ts` files.

## Not done (explicit scope boundary)

Did not touch `.env`, `feature_list.json`, or `specs/` — the task's own
constraints list. Feature status was left as `pending` in `feature_list.json`
(setting it to `in_review` is the generic implementer convention, but this
task's explicit constraint list names `feature_list.json` as off-limits, and
the more specific instruction wins). Did not commit anything.

## Review fixes — secrets, the .99 miss rate, dead config, and the SQLite story

Fixes the four defects `progress/review_n8n_workflows.md` rejected on: D1
(the `.99` engineering), D2 (four dead env vars), D3 (secret exposure), D4
(four false MySQL statements). D5–D8 were not requested for this pass.

### D3 — secrets, fixed first

`docker-compose.infra.yml`'s `n8n:`/`n8n-init:` services no longer carry
`env_file: [.env]`. Both now use an explicit `environment:` allowlist —
exactly the ~25 `OTC_*`/`GATEWAY_OPERATOR_*`/`ORDER_GENERATOR_*`/
`PAYMENT_ROBOT_*`/`STOCK_REPLENISH_*`/`BURST_*`/`N8N_WORKFLOWS_ENABLED`
values the four workflows read via `$env.*`, plus n8n's own operational
config (encryption key, basic-auth, host/port). `N8N_BLOCK_ENV_ACCESS_IN_NODE`
stays `false` — the workflows only function by reading `$env`, and flipping
it would break all four — so the fix is "the container's own env has nothing
worth exfiltrating", not "Code nodes can't read `$env`".

In-container proof, recreated containers, both clean:

```
$ docker exec otc-n8n env | grep -iE "MYSQL_ROOT_PASSWORD|JWT_SECRET|MAILTRAP_PASSWORD|DB_MYSQLDB"
NONE FOUND
$ docker inspect otc-n8n-init --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -iE "MYSQL_ROOT_PASSWORD|JWT_SECRET|MAILTRAP_PASSWORD|DB_MYSQLDB"
(no matches — n8n-init only carries DB_TYPE, N8N_ENCRYPTION_KEY, N8N_WORKFLOWS_ENABLED)
```

Full `docker exec otc-n8n env` now lists only the allowlisted `OTC_*`/
`GATEWAY_OPERATOR_*`/`ORDER_GENERATOR_*`/`PAYMENT_ROBOT_*`/
`STOCK_REPLENISH_*`/`BURST_*`/`N8N_*` values plus stock container variables
(`HOME`, `PATH`, `NODE_ENV`, etc.) — no MySQL, no JWT, no Mailtrap.

### D1 — the `.99` fix, and the before/after numbers

`engineerCompensation()` in both `1-order-generator.json` and `4-burst.json`
now forces the engineered line's `quantity` to `1` before computing the
mod-100 delta, instead of adjusting the last line's `unitPrice` at whatever
quantity it already had. `gcd(1, 100) = 1`, so every residue `0..99` is
reachable by a **non-negative** addition to `unitPrice` — the adjustment can
never drive a price negative, so the "counts a miss" branch is now genuinely
unreachable (kept as a defensive `return false` per spec §3.2's own
"impossible... but checked anyway" language) rather than silently deleted.

Re-ran the reviewer's exact methodology — extracted `engineerCompensation`
**verbatim from the committed JSON files themselves** (not a hand-copy) via a
small Python/Node harness, composed 200,000 orders against the real seeded
price shape (`apps/seed/src/data/products.data.ts`, prices 165–24999) with
the generator's own `maxLines=4`/`maxUnits=10` ranges:

```
BEFORE (committed function prior to this fix, re-measured):
  attempts 200000  engineered OK 104393 (52.20%)  MISS 95607 (47.80%)  claimed-ok-but-not-.99 0
  => effective ratio at 0.15 = 0.0783 / at 0.20 = 0.1044

AFTER (extracted verbatim from n8n/workflows/1-order-generator.json):
  attempts 200000  engineered OK 200000 (100.00%)  MISS 0 (0.00%)  claimed-ok-but-not-.99 0

AFTER (extracted verbatim from n8n/workflows/4-burst.json):
  attempts 200000  engineered OK 200000 (100.00%)  MISS 0 (0.00%)  claimed-ok-but-not-.99 0
```

100% hit rate both places — the configured ratio (`0.15`/`0.20`) is now the
delivered ratio, not half of it.

Also proved **live**, against the real running Gateway, not just the offline
harness: published `otcBurst` (webhook — takes effect immediately, no
restart, per the D8 finding this review already established),
`POST /webhook/otc-burst {"count":10,"compensationRatio":1}` → `9 placed, 1
refused`. Queried all 9 via `GET /orders` with the operator token:

```
ORD-000034 total=2399   mod100=99  status=cancelled credit_rejected
ORD-000035 total=2799   mod100=99  status=cancelled credit_rejected
ORD-000036 total=26399  mod100=99  status=cancelled credit_rejected
ORD-000037 total=15899  mod100=99  status=cancelled credit_rejected
ORD-000038 total=1499   mod100=99  status=cancelled credit_rejected
ORD-000039 total=2099   mod100=99  status=cancelled credit_rejected
ORD-000040 total=213299 mod100=99  status=cancelled credit_rejected
ORD-000041 total=3999   mod100=99  status=cancelled credit_rejected
ORD-000042 total=8399   mod100=99  status=cancelled credit_rejected
```

9/9 (100%) hit `.99` exactly and reached `cancelled`/`credit_rejected` — the
real saga reacting to the real credit simulator, end to end. Unpublished
`otcBurst` afterward; confirmed `active=0` and the webhook 404s again.

### D2 — the four dead env vars: wired, not just documented

Tested first whether n8n's schedule/webhook trigger nodes can genuinely take
an env-driven value, since the review flagged this as "plausible" not to
work. They can. Proof, via a disposable `docker run` container (not
`otc-n8n`) with `ORDER_GENERATOR_INTERVAL_SECONDS=11` and a schedule trigger
whose `secondsInterval` was set to `={{ $env.ORDER_GENERATOR_INTERVAL_SECONDS }}`:
after a restart (publishing a schedule trigger needs one — already known,
see D8 in the review), executions landed at `:00`, `:11`, `:22`, `:33`,
`:44` — exactly 11s apart. A second throwaway container with
`BURST_WEBHOOK_PATH=my-custom-path` served `200` on
`/webhook/my-custom-path` while the hardcoded `otc-burst` path 404'd on the
same instance.

Wired all four for real:

- `1-order-generator.json`'s trigger: `secondsInterval` is now
  `={{ Number($env.ORDER_GENERATOR_INTERVAL_SECONDS) || 45 }}` (was a bare
  `45`).
- `2-payment-robot.json`'s trigger: switched `field` from `minutes`
  (`minutesInterval: 2`) to `seconds`, `secondsInterval` is now
  `={{ Number($env.PAYMENT_ROBOT_INTERVAL_SECONDS) || 120 }}` — this
  variable was always documented in seconds; the trigger unit didn't match
  it even before this fix.
- `3-stock-replenishment.json`'s trigger: same switch, default `300`.
- `4-burst.json`'s webhook node: `path` is now
  `={{ $env.BURST_WEBHOOK_PATH || 'otc-burst' }}` (was a bare `"otc-burst"`).

Re-verified the payment robot's specific switch (minutes→seconds field type,
the highest-risk part of the four) live, against the actual committed
`2-payment-robot.json` file imported into a throwaway container with
`PAYMENT_ROBOT_INTERVAL_SECONDS=8`: executions landed at `:24`, `:32`,
`:40`, `:48`, `:56` — 8s apart, confirming the field-type change plus
expression both work together, not just in isolation.

`grep -c 'INTERVAL_SECONDS\|BURST_WEBHOOK_PATH' n8n/workflows/*.json` now
returns non-zero in all four files (was `0` in all four at review time).
`.env.example` and `README.md` both note the one caveat this genuinely has:
a value change takes effect only after the workflow is republished and
`n8n` is restarted — the same restart requirement D8 already established for
activation in general, not a new one this fix introduces.

### D4 — the SQLite story, corrected everywhere

- **`n8n-init`'s `DB_TYPE: mysqldb`** — changed to `DB_TYPE: sqlite`,
  explicitly, with a comment explaining why (n8n 2.36.2 dropped MySQL
  upstream). Same change applied to the main `n8n:` service's `DB_TYPE` for
  consistency — it carried the same dead value and produced the same warning
  on every normal container start, not just import/export.
- **`.env.example:43`'s `MYSQL_DB_N8N`** — removed, with a one-line note
  explaining why it isn't there rather than silently vanishing. The `mysql:`
  service's own `MYSQL_DB_N8N: ${MYSQL_DB_N8N:-n8n}` line was removed too.
- **The healthcheck comment claiming a MySQL check** — corrected: `n8n:`'s
  healthcheck comment now says what `/healthz/readiness` actually checks
  (n8n's own SQLite-backed readiness), explicitly stating this service has no
  MySQL connection.
- **`depends_on: mysql: service_healthy`** on the `n8n:` service — removed,
  with a comment recording why (this service never contacts MySQL).
- **`infra/mysql/init/01-create-databases.sh`** — the unused `n8n` database
  creation/grant was removed (this file was outside the original feature's
  enumerated scope, and the original write-up should have named it as a
  place the SQLite finding invalidated a statement; doing so now). This only
  affects a *fresh* MySQL data directory — it does not retroactively drop the
  already-created (always-empty) `n8n` database in the live `mysql_data`
  volume, which was left alone as out of scope for a running data volume.

Verified live: `docker logs otc-n8n 2>&1 | grep -i DB_TYPE` and the same for
`otc-n8n-init` and for a fresh `pnpm n8n:import` run — **zero matches**, all
three, where before every one of them printed `Invalid value for DB_TYPE ...
Falling back to default value` as routine output.

### Round-trip, workflow count, and inactive state after all of the above

```
$ pnpm n8n:import
Importing 4 workflows...
Successfully imported 4 workflows.
$ pnpm n8n:export
$ diff -r <pre-session snapshot> n8n/workflows/
(no output — clean round-trip)
```

`SELECT id, name, active, isArchived FROM workflow_entity` inside `otc-n8n`:
exactly the 4 committed ids, all `active=0`, `isArchived=0`. One stray
workflow (`otcTestIntervalExpr`, a throwaway created while proving D2 against
the shared `otc-n8n` container — the `docker cp` used to seed it landed on
the bind-mounted host `n8n/workflows/` directory, since `n8n_data` volume
mounts are the *`.n8n` state* mount, but the *workflow JSON* mount is a bind
mount to the repo, not a container-only path) was found, its stray host file
removed, and the workflow row plus every cascading reference (`execution_*`,
`shared_workflow`, `insights_*`, `workflow_statistics`, `workflow_history`,
`workflow_dependency`) deleted via a direct `node:sqlite` script (no
`delete:workflow` CLI command in this n8n version — same escape hatch the
original implementation used and documented). `PRAGMA foreign_key_check`
confirmed zero violations afterward. Final state: 18 containers healthy, 4
workflows, all inactive, no strays — the same state the review found, plus
the fixes.

### D8 — one correction folded in here too

While proving D2 live, re-confirmed D8's own finding (webhook activation
takes effect immediately, schedule activation needs a restart) and narrowed
`README.md`'s activation paragraph accordingly — it previously stated the
restart requirement as if it applied to all four workflows.

### Cleanup discipline

Every throwaway container (`otc-n8n-expr-test`, `otc-n8n-verify2`) and their
named volumes were removed after use; `otc-n8n`/`otc-n8n-init` were
recreated cleanly via `docker compose ... up -d n8n n8n-init` to pick up the
compose changes. `docker volume ls` was checked for stray anonymous volumes
from this session — none found (the n8n image does not declare a Dockerfile
`VOLUME`, so an unmounted container leaves nothing behind). A handful of
pre-existing anonymous volumes and stopped containers unrelated to this
project (created hours/months before this session, per `docker inspect
--format '{{.CreatedAt}}'`) were identified and deliberately left alone —
not this feature's to clean up.
