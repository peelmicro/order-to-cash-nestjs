#!/bin/bash
# Exports the four committed n8n demo workflows back out of the running n8n
# container into n8n/workflows/ — the reverse of import-n8n-workflows.sh, so
# the committed JSON is what n8n itself produces after an edit in the UI,
# never hand-written by drifting from what n8n actually runs.
#
# Exports by workflow ID (not `--all`) so a stray test/probe workflow someone
# left in the instance is never accidentally committed — see
# specs/shared/n8n-workflows.md for what each of the four IDs is.
#
# Exports the CURRENT (draft/editor) version of each workflow, i.e. whatever
# is shown in the n8n UI right now — not necessarily what is currently
# published/active, if those have diverged. Pass --published to this script
# to export the published/live version instead (n8n's own
# `export:workflow --published` flag).
#
# n8n's raw `export:workflow` output wraps the workflow in a one-element
# array and embeds this n8n instance's own identity and bookkeeping —
# `shared[].project` (the logged-in operator's real name and email!),
# `versionId`/`activeVersionId`/`versionCounter`/`sourceWorkflowId`,
# `createdAt`/`updatedAt`, `triggerCount`, `isArchived`, empty `tags`/
# `pinData`/`nodeGroups`/`staticData`/`meta`. None of that is portable
# (a fresh n8n instance — including assessments #8/#9's — has no such
# project id) and `shared[].project` is a real person's PII that must never
# land in a committed file. This script unwraps the array and strips all of
# that down to the minimal, portable shape (id, name, nodes, connections,
# settings, active) — exactly the shape import-n8n-workflows.sh's
# `import:workflow` already accepts (this is how the four files were
# authored in the first place; this script keeps re-exports in that same
# shape so a diff shows only real content changes, not n8n's bookkeeping
# noise).
#
# Usage:
#   pnpm n8n:export
#   ./scripts/export-n8n-workflows.sh [--published]

set -e

CONTAINER=otc-n8n
HOST_WORKFLOW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/n8n/workflows"
CONTAINER_WORKFLOW_DIR=/home/node/workflows
PUBLISHED_FLAG=""
if [ "$1" = "--published" ]; then
  PUBLISHED_FLAG="--published"
fi

if ! docker ps --format '{{.Names}}' | grep -q "^$CONTAINER$"; then
  echo "Error: container $CONTAINER is not running. Run 'pnpm dc:up:infra' (or 'pnpm dc:up:apps') first." >&2
  exit 1
fi

declare -A WORKFLOWS=(
  [otcOrderGenerator]="1-order-generator.json"
  [otcPaymentRobot]="2-payment-robot.json"
  [otcStockReplenishment]="3-stock-replenishment.json"
  [otcBurst]="4-burst.json"
)

echo "Exporting n8n workflows from container $CONTAINER..."
for id in "${!WORKFLOWS[@]}"; do
  file="${WORKFLOWS[$id]}"
  echo "  $id -> n8n/workflows/$file"
  docker exec "$CONTAINER" n8n export:workflow --id="$id" $PUBLISHED_FLAG --output="$CONTAINER_WORKFLOW_DIR/.export-$file"
  python3 - "$HOST_WORKFLOW_DIR/.export-$file" "$HOST_WORKFLOW_DIR/$file" << 'PYEOF'
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
with open(src) as f:
    data = json.load(f)
workflow = data[0] if isinstance(data, list) else data

portable = {
    "id": workflow["id"],
    "name": workflow["name"],
    "nodes": workflow["nodes"],
    "connections": workflow["connections"],
    "active": workflow["active"],
    "settings": workflow.get("settings", {"executionOrder": "v1"}),
}

with open(dst, "w") as f:
    json.dump(portable, f, indent=2)
    f.write("\n")
PYEOF
  rm -f "$HOST_WORKFLOW_DIR/.export-$file"
done

echo ""
echo "Done. n8n/workflows/*.json now reflects what n8n itself has for these four workflows"
echo "(stripped of this instance's own identity/bookkeeping fields — see this script's header)."
echo "Review the diff before committing — 'git diff n8n/workflows/'."
