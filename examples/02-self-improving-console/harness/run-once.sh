#!/usr/bin/env bash
# harness/run-once.sh <iter> — run the console-rebuild swarm HEADLESS, once.
#
# Runs on the MAIN demo branch (agents reliably target the canonical repo path, so a
# worktree leaks — see ITERATIONS.md iter 2). Isolation = a git reset of the console
# scaffold BEFORE each run; a unique mesh space per run isolates the traffic.
#
# - reset console scaffold to committed placeholder state (clean slate)
# - NATS open mode (observer can see DMs → peer-to-peer visibility)
# - manager headless on the PTY runtime (open stdin + dev-channels auto-confirm)
# - orchestrator spawned via the manager (`cotal start`); it cotal_spawns the workers
# - observer logs ALL traffic to .runs/run-<iter>/transcript.jsonl
# - wait for "DEMO COMPLETE" / timeout, tear down, evaluate (build main + comms)
#
# Does NOT reset at the end (last run stays inspectable); the next run resets first.
set -uo pipefail

ITER="${1:-0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EX="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$EX/../.." && pwd)"
SPACE="console-r$ITER"
SERVER="${COTAL_SERVERS:-nats://127.0.0.1:4222}"
TIMEOUT="${RUN_TIMEOUT:-900}"
TSX="$REPO/node_modules/.bin/tsx"
RESULTS="$REPO/.runs/run-$ITER"
EXREL="examples/02-self-improving-console"

log() { echo "[run-once $ITER] $*"; }

mkdir -p "$RESULTS"

# --- reset the console scaffold to committed placeholder state -------------
# Only the swarm-owned files. NOT package.json/tsconfig/pnpm-lock — parallel
# licensing work lives there and the swarm doesn't need to touch deps (already committed).
git -C "$REPO" checkout -- \
  implementations/cli/src/console \
  implementations/cli/src/commands/console-ink.tsx \
  implementations/cli/src/index.ts 2>/dev/null || true
git -C "$REPO" clean -fd implementations/cli/src/console/ui >/dev/null 2>&1 || true
log "console scaffold reset to clean state"

# --- NATS (open mode so DMs are observable) -------------------------------
nats_up() { (exec 3<>/dev/tcp/127.0.0.1/4222) 2>/dev/null; }
if ! nats_up; then
  log "starting NATS (open mode)"
  ( cd "$REPO" && nohup pnpm cotal up --open --store-dir "$RESULTS/.nats" >"$HERE/.mesh-$ITER.log" 2>&1 & )
  for _ in $(seq 1 40); do nats_up && break; sleep 0.25; done
fi
nats_up || { log "NATS did not come up"; exit 3; }

TRANSCRIPT="$RESULTS/transcript.jsonl"
: > "$TRANSCRIPT"

# --- observer (all traffic -> transcript) ---------------------------------
COTAL_SPACE="$SPACE" COTAL_SERVERS="$SERVER" TRANSCRIPT="$TRANSCRIPT" \
  "$TSX" "$REPO/$EXREL/harness/observer.ts" >"$HERE/.observer-$ITER.log" 2>&1 &
OBS=$!

# --- manager (pty runtime, headless → all spawned agents inherit headless) -
COTAL_HEADLESS=1 COTAL_SPACE="$SPACE" COTAL_SERVERS="$SERVER" COTAL_RUNTIME=pty \
  "$TSX" "$REPO/$EXREL/src/manager.ts" >"$HERE/.manager-$ITER.log" 2>&1 &
MGR=$!
sleep 4

# --- orchestrator via the manager (PTY runtime → open stdin + auto-confirm) -
COTAL_SPACE="$SPACE" COTAL_SERVERS="$SERVER" \
  "$TSX" "$REPO/bin/cotal.ts" start --space "$SPACE" --server "$SERVER" \
    --name orchestrator --role orchestrator >"$HERE/.orch-start-$ITER.log" 2>&1 \
  || log "cotal start orchestrator failed (see .orch-start-$ITER.log)"
log "swarm running (space=$SPACE, timeout=${TIMEOUT}s) — mgr=$MGR obs=$OBS"

# --- wait for completion / timeout ----------------------------------------
deadline=$(( $(date +%s) + TIMEOUT ))
outcome="timeout"
while [ "$(date +%s)" -lt "$deadline" ]; do
  if grep -q "DEMO COMPLETE" "$TRANSCRIPT" 2>/dev/null; then outcome="complete"; break; fi
  if ! kill -0 "$MGR" 2>/dev/null; then outcome="manager-died"; break; fi
  sleep 5
done
log "outcome: $outcome"

# --- teardown (specific PIDs only; never broad-pkill claude) ---------------
kill "$MGR" 2>/dev/null || true      # manager's SIGTERM handler stops spawned agents
sleep 2
kill "$OBS" 2>/dev/null || true

# --- evaluate (typecheck MAIN repo where the swarm wrote; comms from transcript) -
VERDICT="$RESULTS/verdict.json"
"$TSX" "$REPO/$EXREL/harness/evaluate.ts" "$REPO" "$TRANSCRIPT" >"$VERDICT" 2>"$HERE/.evaluate-$ITER.log" || true
log "verdict -> $VERDICT"
cat "$VERDICT" 2>/dev/null || echo '{"green":false,"failureMode":"evaluate-failed"}'
echo "OUTCOME=$outcome"
