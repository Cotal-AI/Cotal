#!/usr/bin/env bash
# Bring up the Cotal mesh and lay out the self-improving-console demo in cmux.
#
#   ./launch.sh           verify the mesh, print the cmux launch sequence
#   ./launch.sh --drive   open the console + orchestrator; the orchestrator grows the team
#   ./launch.sh --stop    stop the manager(s) for this space
#
# Layout (one workspace): the live console dashboard (what we watch the swarm through)
# on top, the orchestrator below. The orchestrator spawns research / backend / tui-designer
# into their own tabs on demand.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SPACE="console"

TSX="$REPO_ROOT/node_modules/.bin/tsx"
CMUX="$TSX $REPO_ROOT/extensions/cmux/src/cli.ts"
cmux_check() {
  $CMUX check || { echo "✗ can't reach cmux — run this from inside a cmux terminal." >&2; exit 1; }
}

term() { printf '{"pane":{"surfaces":[{"type":"terminal","command":"%s"}]}}' "$1"; }

manager_term() { # the example manager as a live pane (cmux runtime), so its spawns are authorized
  term "bash -lc 'cd $HERE && COTAL_SPACE=$SPACE COTAL_RUNTIME=cmux exec $TSX $HERE/src/manager.ts'"
}
manager_up() {
  if pgrep -f "$HERE/src/manager.ts" >/dev/null; then
    echo "✓ manager already running"
  else
    echo "opening the manager in its own cmux tab so the orchestrator can grow the team…"
    $CMUX open cotal-manager "$(manager_term)"
  fi
}

if [[ "${1:-}" == "--stop" ]]; then
  if pkill -f "$HERE/src/manager.ts"; then echo "✓ stopped manager(s) for space $SPACE"; else echo "no manager running"; fi
  exit 0
fi

# --- mesh ------------------------------------------------------------------
nats_up() { (exec 3<>/dev/tcp/127.0.0.1/4222) 2>/dev/null; }
if nats_up; then
  echo "✓ NATS already up on 127.0.0.1:4222"
else
  command -v nats-server >/dev/null || { echo "✗ nats-server not found. Install: brew install nats-server" >&2; exit 1; }
  echo "starting the mesh (pnpm cotal up) in the background…"
  ( cd "$REPO_ROOT" && nohup pnpm cotal up >"$HERE/.mesh.log" 2>&1 & )
  for _ in $(seq 1 20); do nats_up && break; sleep 0.25; done
  nats_up && echo "✓ mesh up (log: $HERE/.mesh.log)" || { echo "✗ mesh did not come up — see $HERE/.mesh.log" >&2; exit 1; }
fi

agent_term() { term "bash -lc '$HERE/run-agent.sh $1'"; }

build_layout() {
  printf '{"direction":"vertical","split":0.4,"children":[%s,%s]}' \
    "$(term "bash -lc 'cd $REPO_ROOT && pnpm cotal console --space $SPACE'")" \
    "$(agent_term orchestrator)"
}

if [[ "${1:-}" == "--drive" ]]; then
  cmux_check
  manager_up
  echo "opening the cotal-console workspace (console + orchestrator)…"
  $CMUX open cotal-console "$(build_layout)"
  echo "✓ workspace opened. Approve the plugin in the orchestrator pane if prompted, then give it"
  echo "  the goal (examples/02-self-improving-console/GOAL.md). It spawns research/backend/tui-designer."
  exit 0
fi

cat <<EOF

Mesh is up. Easiest: re-run with --drive (from inside a cmux terminal) to open the console +
orchestrator. Give the orchestrator the goal (GOAL.md) and it spawns research / backend /
tui-designer into their own tabs:

  ./launch.sh --drive

Or open plain terminals / use the cmux.json palette. Start the orchestrator with:

  ./run-agent.sh orchestrator

(research / backend / tui-designer are spawned by the orchestrator — or launch any by hand with
run-agent.sh <role>.)
EOF
