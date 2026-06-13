#!/usr/bin/env bash
# face-wall.sh — spawn a tmux grid of animated agent faces, one OpenCode session per pane.
#
#   ./face-wall.sh                 # one pane per available persona (capped at 9)
#   ./face-wall.sh ray david neon  # explicit personas (repeat freely, e.g. fill 9)
#
# Each pane runs face-term.mjs with a different persona against ONE shared opencode server,
# so the grid = N independent live agents you can talk to side by side.
#
# Env: PORT (4096) · MODEL (opencode-go/glm-5.1) · OPENCODE_BIN (~/.bun/bin/opencode)
#      SESSION (faces) · RUNNER (node)
# Teardown: tmux kill-session -t "$SESSION"
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-4096}"
MODEL="${MODEL:-opencode-go/glm-5.1}"
OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.bun/bin/opencode}"
SESSION="${SESSION:-faces}"
RUNNER="${RUNNER:-node}"
SERVER="http://127.0.0.1:${PORT}"
MAX=9

command -v tmux >/dev/null || { echo "face-wall: tmux not found" >&2; exit 1; }

# personas: args, else everything personas.mjs exports
if [ "$#" -gt 0 ]; then
  PERSONAS=("$@")
else
  # shellcheck disable=SC2207
  PERSONAS=($("$RUNNER" "$DIR/face-term.mjs" --list))
fi
[ "${#PERSONAS[@]}" -gt "$MAX" ] && { echo "face-wall: capping at $MAX panes (got ${#PERSONAS[@]})" >&2; PERSONAS=("${PERSONAS[@]:0:$MAX}"); }
[ "${#PERSONAS[@]}" -gt 0 ] || { echo "face-wall: no personas" >&2; exit 1; }

# ensure an opencode server is up (start it if not)
if ! curl -fsS -o /dev/null "${SERVER}/api/health" 2>/dev/null; then
  echo "face-wall: starting opencode server on :${PORT} ..." >&2
  [ -x "$OPENCODE_BIN" ] || { echo "face-wall: no opencode at $OPENCODE_BIN (set OPENCODE_BIN)" >&2; exit 1; }
  "$OPENCODE_BIN" serve --port "$PORT" >/tmp/face-wall-opencode.log 2>&1 &
  for _ in $(seq 1 40); do
    curl -fsS -o /dev/null "${SERVER}/api/health" 2>/dev/null && break
    sleep 0.5
  done
  curl -fsS -o /dev/null "${SERVER}/api/health" 2>/dev/null || { echo "face-wall: server never came up (see /tmp/face-wall-opencode.log)" >&2; exit 1; }
fi

cmd_for() { printf '%s %q --persona %q --server %q --model %q' "$RUNNER" "$DIR/face-term.mjs" "$1" "$SERVER" "$MODEL"; }

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" "$(cmd_for "${PERSONAS[0]}")"
for ((i = 1; i < ${#PERSONAS[@]}; i++)); do
  tmux split-window -t "$SESSION" "$(cmd_for "${PERSONAS[$i]}")"
  tmux select-layout -t "$SESSION" tiled >/dev/null
done
tmux select-layout -t "$SESSION" tiled >/dev/null
tmux set-option -t "$SESSION" mouse on >/dev/null 2>&1 || true

echo "face-wall: ${#PERSONAS[@]} faces in tmux session '$SESSION' (${PERSONAS[*]})" >&2
if [ -n "${NO_ATTACH:-}" ] || { [ ! -t 1 ] && [ -z "${TMUX:-}" ]; }; then
  echo "face-wall: not attaching — run: tmux attach -t $SESSION" >&2
elif [ -n "${TMUX:-}" ]; then
  tmux switch-client -t "$SESSION"
else
  tmux attach -t "$SESSION"
fi
