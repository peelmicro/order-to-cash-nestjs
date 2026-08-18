#!/usr/bin/env bash
# init.sh — Environment and state coherence check.
#
# Run this at the START of every session, and again before declaring any
# feature `done`. If it fails, the session must not advance.
#
# Exit codes: 0 = healthy, 1 = at least one [FAIL].

set -u

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { printf "${GREEN}[OK]${NC}    %s\n" "$1"; }
warn() { printf "${YELLOW}[WARN]${NC}  %s\n" "$1"; }
fail() { printf "${RED}[FAIL]${NC}  %s\n" "$1"; EXIT_CODE=1; }
section() { printf "\n${BLUE}── %s ${NC}\n" "$1"; }

EXIT_CODE=0
cd "$(dirname "$0")" || exit 1

# ─────────────────────────────────────────────────────────────
section "1. Environment"

if command -v node >/dev/null 2>&1; then
  NODE_ACTUAL="$(node -v | sed 's/^v//')"
  if [ -f .nvmrc ]; then
    NODE_WANTED="$(tr -d ' \n\r' < .nvmrc)"
    if [ "$NODE_ACTUAL" = "$NODE_WANTED" ]; then
      ok "node $NODE_ACTUAL matches .nvmrc"
    else
      warn "node $NODE_ACTUAL does not match .nvmrc ($NODE_WANTED) — run 'nvm use'"
    fi
  else
    ok "node $NODE_ACTUAL (no .nvmrc)"
  fi
else
  fail "node is not installed"
fi

if command -v pnpm >/dev/null 2>&1; then ok "pnpm $(pnpm -v)"; else fail "pnpm is not installed"; fi

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then ok "docker daemon reachable"; else warn "docker installed but daemon not reachable"; fi
else
  warn "docker not installed (required from phase 4 onwards)"
fi

# ─────────────────────────────────────────────────────────────
section "2. Harness files"

for f in AGENTS.md CLAUDE.md CHECKPOINTS.md feature_list.json progress/current.md progress/history.md; do
  [ -f "$f" ] && ok "$f present" || fail "$f is missing"
done

AGENT_COUNT=$(find .claude/agents -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
if [ "$AGENT_COUNT" -ge 4 ]; then ok ".claude/agents/ has $AGENT_COUNT agent definitions"; else fail ".claude/agents/ has only $AGENT_COUNT definitions (expected >= 4)"; fi

# Every agent must declare its model explicitly, or say it deliberately inherits.
for f in .claude/agents/*.md; do
  [ -e "$f" ] || continue
  if grep -q '^model:' "$f"; then
    ok "$(basename "$f") pins model: $(grep '^model:' "$f" | head -1 | cut -d' ' -f2)"
  elif grep -qi 'inherit' "$f"; then
    ok "$(basename "$f") deliberately unpinned (documented)"
  else
    fail "$(basename "$f") neither pins a model nor documents inheriting one"
  fi
done

# ─────────────────────────────────────────────────────────────
section "3. Backlog coherence"

if [ -f feature_list.json ] && command -v node >/dev/null 2>&1; then
  node - <<'NODE'
const fs = require('fs');
let d;
try { d = JSON.parse(fs.readFileSync('feature_list.json', 'utf8')); }
catch (e) { console.log(`\x1b[0;31m[FAIL]\x1b[0m  feature_list.json is not valid JSON: ${e.message}`); process.exit(1); }

const ok   = m => console.log(`\x1b[0;32m[OK]\x1b[0m    ${m}`);
const fail = m => { console.log(`\x1b[0;31m[FAIL]\x1b[0m  ${m}`); process.exitCode = 1; };
const warn = m => console.log(`\x1b[0;33m[WARN]\x1b[0m  ${m}`);

const valid = d.rules.valid_status;
ok(`feature_list.json parsed — ${d.features.length} features`);

const bad = d.features.filter(f => !valid.includes(f.status));
bad.length ? fail(`invalid status on: ${bad.map(f => `${f.name}=${f.status}`).join(', ')}`)
           : ok('every status is in the valid set');

const inProgress = d.features.filter(f => f.status === 'in_progress');
if (inProgress.length > 1) fail(`${inProgress.length} features in_progress (max 1): ${inProgress.map(f => f.name).join(', ')}`);
else if (inProgress.length === 1) ok(`1 feature in_progress: ${inProgress[0].name}`);
else ok('no feature in_progress');

const ids = d.features.map(f => f.id);
new Set(ids).size === ids.length ? ok('feature ids are unique') : fail('duplicate feature ids');

const blocked = d.features.filter(f => f.status === 'blocked');
if (blocked.length) warn(`${blocked.length} blocked: ${blocked.map(f => f.name).join(', ')}`);

// SDD coherence: a sdd:true feature past `pending` needs its triple-doc.
const needsSpec = d.features.filter(f => f.sdd && ['spec_ready','in_progress','in_review','done'].includes(f.status));
let missing = 0;
for (const f of needsSpec) {
  for (const doc of ['requirements.md','design.md','tasks.md']) {
    if (!fs.existsSync(`specs/${f.name}/${doc}`)) { fail(`specs/${f.name}/${doc} missing (feature is ${f.status})`); missing++; }
  }
}
if (!missing) ok(`SDD coherence: ${needsSpec.length} sdd feature(s) past pending have their triple-doc`);

const done = d.features.filter(f => f.status === 'done').length;
ok(`progress: ${done}/${d.features.length} features done`);
NODE
  [ $? -ne 0 ] && EXIT_CODE=1
else
  fail "cannot validate feature_list.json (missing file or node)"
fi

# ─────────────────────────────────────────────────────────────
section "4. Repository state"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  ok "git repo on branch '$(git rev-parse --abbrev-ref HEAD)'"
  DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
  [ "$DIRTY" -eq 0 ] && ok "working tree clean" || warn "$DIRTY uncommitted change(s) — expected mid-session"
  git config --local --get user.email >/dev/null 2>&1 \
    && ok "repo-local git identity: $(git config --local --get user.name) <$(git config --local --get user.email)>" \
    || warn "no repo-local git identity set"
else
  fail "not inside a git repository"
fi

# ─────────────────────────────────────────────────────────────
section "5. Tests"

if [ -f package.json ]; then
  if grep -q '"test"' package.json; then
    warn "test script present — run 'pnpm test' before closing a feature (not run here to keep init.sh fast)"
  else
    warn "no test script in package.json yet"
  fi
else
  warn "no root package.json yet (arrives in phase 5)"
fi

# ─────────────────────────────────────────────────────────────
printf "\n"
if [ "$EXIT_CODE" -eq 0 ]; then
  printf "${GREEN}══ init.sh: environment and state are coherent ══${NC}\n"
else
  printf "${RED}══ init.sh: FAILURES above — do not advance the session ══${NC}\n"
fi
exit $EXIT_CODE
