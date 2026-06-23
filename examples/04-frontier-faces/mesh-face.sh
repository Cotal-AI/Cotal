#!/usr/bin/env bash
# mesh-face.sh <cotal-name> <persona-key> <port> [agent-file]
# Start an OpenCode mesh agent (cotal plugin → joins the mesh) and render its session
# as a pixel face. One pane per persona. Reads the EXACT session id this run prints,
# so duplicate cotal:demo:* sessions from prior runs don't matter.
#
#   env: COTAL_SPACE (demo) · COTAL_SERVERS (nats://127.0.0.1:4222) · MODEL (from agent file)
#   teardown: Ctrl-C this pane (the trap kills the server it started)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
NAME="$1"; PERSONA="$2"; PORT="$3"
AGENT="${4:-$DIR/agents/$NAME.md}"
PLUGIN="$ROOT/extensions/connector-opencode/dist/plugin.bundle.js"
[ -f "$AGENT" ]  || { echo "mesh-face: no agent file: $AGENT" >&2; exit 1; }
[ -f "$PLUGIN" ] || { echo "mesh-face: missing $PLUGIN — run: pnpm build" >&2; exit 1; }
MODEL="${MODEL:-$(grep -m1 '^model:' "$AGENT" | sed 's/model:[[:space:]]*//' || true)}"
LOG="/tmp/cotal-face-$NAME.log"

export COTAL_SPACE="${COTAL_SPACE:-demo}" COTAL_NAME="$NAME" \
  COTAL_SERVERS="${COTAL_SERVERS:-nats://127.0.0.1:4222}" COTAL_AGENT_FILE="$AGENT" \
  OPENCODE_CONFIG_CONTENT="{\"\$schema\":\"https://opencode.ai/config.json\",\"permission\":\"allow\",\"plugin\":[\"$PLUGIN\"]${MODEL:+,\"model\":\"$MODEL\"}}"

echo "mesh-face: $NAME on :$PORT (face=$PERSONA, model=${MODEL:-default}) — log $LOG"
opencode serve --hostname 127.0.0.1 --port "$PORT" >"$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT

# Poke the server so the plugin lazy-loads (joins mesh + creates its session); scan for its id.
SID=""
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/session" 2>/dev/null || true
  SID="$(grep -m1 -oE '\[cotal-session\] \S+' "$LOG" 2>/dev/null | awk '{print $2}')" || true
  [ -n "$SID" ] && break
  sleep 0.5
done
[ -n "$SID" ] || { echo "mesh-face: no [cotal-session] in $LOG:" >&2; tail -20 "$LOG" >&2; exit 1; }

echo "mesh-face: $NAME session=$SID — attaching face"
node "$DIR/face-term.mjs" --persona "$PERSONA" --server "http://127.0.0.1:$PORT" --session "$SID"
