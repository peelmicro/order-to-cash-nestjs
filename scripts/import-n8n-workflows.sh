#!/bin/bash
# Imports the four committed n8n demo workflows (n8n/workflows/*.json) into the
# running n8n container — see specs/shared/n8n-workflows.md.
#
# Mirrors airline-transaction-monitor/scripts/import-n8n-workflows.sh: check
# the container is up, then run the n8n CLI's own `import:workflow` against
# the SAME directory that is bind-mounted into the container at
# /home/node/workflows (docker-compose.infra.yml's n8n service). This is the
# manual, run-it-whenever-you-like path — for the automatic one that runs on
# every `docker compose up`, see the `n8n-init` one-shot service in
# docker-compose.infra.yml and infra/n8n/import-workflows-on-startup.sh. Both
# ultimately call the exact same `n8n import:workflow --separate --input=...`
# CLI command against the same mounted directory, so they cannot drift on
# WHAT they import — the only difference is one runs against the
# already-running container via `docker exec`, the other is its own
# ephemeral container sharing the same `n8n_data` volume.
#
# Every imported workflow always lands INACTIVE (n8n's own
# `import:workflow` default: "false" (default) deactivates all imported
# workflows"), regardless of the committed JSON's own `active` field —
# activate a workflow from the n8n UI (http://localhost:5678/workflows) when
# you actually want its schedule/webhook to start firing.
#
# Usage:
#   pnpm n8n:import
#   ./scripts/import-n8n-workflows.sh

set -e

CONTAINER=otc-n8n
WORKFLOW_DIR=/home/node/workflows

echo "Importing n8n workflows from $WORKFLOW_DIR into container $CONTAINER..."

if ! docker ps --format '{{.Names}}' | grep -q "^$CONTAINER$"; then
  echo "Error: container $CONTAINER is not running. Run 'pnpm dc:up:infra' (or 'pnpm dc:up:apps') first." >&2
  exit 1
fi

docker exec "$CONTAINER" n8n import:workflow --separate --input="$WORKFLOW_DIR"

echo ""
echo "Done. Open http://localhost:5678/workflows to see the imported workflows."
echo "They are imported INACTIVE by design — activate the ones you want running from the UI."
