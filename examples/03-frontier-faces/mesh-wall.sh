#!/usr/bin/env bash
# mesh-wall.sh — one command for the whole demo: start the mesh, spawn a tmux grid of
# mesh faces (one live OpenCode peer each), and open the console on the same space.
#
#   ./mesh-wall.sh                 # curated roster + console
#   ./mesh-wall.sh sven david      # explicit agents (agent-file basenames)
#   ./mesh-wall.sh all             # every agent (capped at 9 panes)
#   ./mesh-wall.sh --stop          # tear it all down (faces, console, and the mesh we started)
#
# Unlike face-wall.sh (standalone direct chat), every pane here is a real Cotal mesh peer:
# the faces coordinate as lateral peers in one space, and the console pane (right) shows the
# live traffic. Persona art is taken from each agent's `face:` frontmatter (else its name).
# Standard layout: the face grid on the LEFT, the console on the RIGHT, in one tmux window.
#
# Env: SPACE (demo) · MODEL (overrides each agent file's model) · SESSION (mesh-faces)
#      CONSOLE_WIDTH (42%) — right-hand console column width
# Requires: node, opencode (run `opencode auth login` for opencode-go), tmux.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
SPACE="${SPACE:-demo}"
SESSION="${SESSION:-mesh-faces}"
PLUGIN="$ROOT/extensions/connector-opencode/dist/plugin.bundle.js"
PIDFILE="/tmp/cotal-mesh-wall.pids"
MESHLOG="/tmp/cotal-mesh-wall.log"
MAX=9
# default to a clean 2x2 (faces render at a fixed 32x16, so 4 leaves each pane big enough).
# names are agent-file basenames; their faces come from `face:` (elon->musk, steve->jobs, rayan->ray).
DEFAULT_ROSTER=(sven david elon garry)

# --- teardown -----------------------------------------------------------------
if [ "${1:-}" = "--stop" ]; then
  tmux kill-session -t "$SESSION" 2>/dev/null && echo "mesh-wall: killed tmux '$SESSION'" >&2 || true
  if [ -f "$PIDFILE" ]; then
    while read -r pid; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done <"$PIDFILE"
    rm -f "$PIDFILE"
    echo "mesh-wall: stopped the mesh it started" >&2
  fi
  exit 0
fi

# --- preflight ----------------------------------------------------------------
for bin in node tmux; do
  command -v "$bin" >/dev/null || { echo "mesh-wall: '$bin' not found on \$PATH" >&2; exit 1; }
done
command -v opencode >/dev/null || {
  echo "mesh-wall: opencode not found on \$PATH — install it, then 'opencode auth login'" >&2; exit 1; }
if [ ! -f "$PLUGIN" ]; then
  echo "mesh-wall: building the cotal plugin (pnpm build) ..." >&2
  ( cd "$ROOT" && pnpm build ) >&2 || { echo "mesh-wall: pnpm build failed" >&2; exit 1; }
fi
opencode auth list 2>/dev/null | grep -qi opencode || \
  echo "mesh-wall: warning — no opencode credential found; run 'opencode auth login' (opencode-go) or pass MODEL=opencode/<free-model>" >&2

# --- resolve roster (agent names; persona comes from each file's `face:`) ------
if [ "$#" -eq 0 ]; then
  ROSTER=("${DEFAULT_ROSTER[@]}")
elif [ "$1" = "all" ]; then
  ROSTER=(); for f in "$DIR"/agents/*.md; do ROSTER+=("$(basename "$f" .md)"); done
else
  ROSTER=("$@")
fi
[ "${#ROSTER[@]}" -gt "$MAX" ] && {
  echo "mesh-wall: capping at $MAX panes (got ${#ROSTER[@]})" >&2; ROSTER=("${ROSTER[@]:0:$MAX}"); }

AGENTS=()
for a in "${ROSTER[@]}"; do
  [ -f "$DIR/agents/$a.md" ] || { echo "mesh-wall: no agent file 'agents/$a.md' (try: ./mesh-wall.sh all)" >&2; exit 1; }
  AGENTS+=("$a")
done

# --- start the mesh if it isn't already up ------------------------------------
nats_up() { (exec 3<>/dev/tcp/127.0.0.1/4222) 2>/dev/null; }
if nats_up; then
  echo "mesh-wall: mesh already up on 127.0.0.1:4222" >&2
else
  echo "mesh-wall: starting mesh (cotal up --open --space $SPACE) ..." >&2
  # nohup + disown so the mesh outlives this launcher (it exits when you detach tmux)
  nohup bash -c 'cd "$1" && exec pnpm cotal up --open --space "$2"' _ "$ROOT" "$SPACE" >"$MESHLOG" 2>&1 &
  echo "$!" >"$PIDFILE"
  disown
  for _ in $(seq 1 40); do nats_up && break; sleep 0.25; done
  nats_up || { echo "mesh-wall: mesh did not come up (see $MESHLOG)" >&2; exit 1; }
  # also record nats-server's own pid so --stop is reliable across pnpm/node wrappers
  np="$(grep -m1 -oE '^\[[0-9]+\]' "$MESHLOG" 2>/dev/null | tr -d '[]' || true)"
  [ -n "$np" ] && echo "$np" >>"$PIDFILE"
  echo "mesh-wall: mesh up (log $MESHLOG)" >&2
fi

# --- build the tmux grid: one mesh-face.sh per agent --------------------------
cmd_for() {  # <index> — serve.js picks a free port; mesh-face derives the persona from `face:`
  local i="$1" pre
  pre="COTAL_SPACE=$(printf %q "$SPACE")"
  [ -n "${MODEL:-}" ] && pre="$pre MODEL=$(printf %q "$MODEL")"
  printf '%s %q %q' "$pre" "$DIR/mesh-face.sh" "${AGENTS[$i]}"
}

# Each pane command runs through `bash -c` (passed as argv): tmux would otherwise feed a
# single command string to the user's default-shell, which may be nu/fish and choke on the
# sh syntax (VAR=val prefixes, &&, exec) below.
tmux kill-session -t "$SESSION" 2>/dev/null || true
# Build at the REAL terminal size: tmux otherwise creates the detached session at 80x24, and
# scaling that tiny layout up on attach distorts the panes (uneven faces). Fall back for non-ttys.
cols=$(tput cols 2>/dev/null || true); lines=$(tput lines 2>/dev/null || true)
[[ "$cols"  =~ ^[0-9]+$ ]] && (( cols  >= 80 )) || cols=200
[[ "$lines" =~ ^[0-9]+$ ]] && (( lines >= 24 )) || lines=50
tmux new-session -d -s "$SESSION" -x "$cols" -y "$lines" bash -c "$(cmd_for 0)"
for ((i = 1; i < ${#AGENTS[@]}; i++)); do
  tmux split-window -t "$SESSION" bash -c "$(cmd_for "$i")"
  tmux select-layout -t "$SESSION" tiled >/dev/null
done
tmux select-layout -t "$SESSION" tiled >/dev/null            # faces fill the window as a grid

# Carve a full-height console column on the RIGHT (faces stay gridded on the left). `-f` spans
# the whole window height, not just the active pane. This is the real `cotal console` (the
# lazygit-style dashboard: roster + channels + live feed), not the --plain log stream.
tmux split-window -h -f -l "${CONSOLE_WIDTH:-42%}" -t "$SESSION" \
  bash -c "cd $(printf %q "$ROOT") && exec pnpm cotal console --space $(printf %q "$SPACE")"
tmux select-pane -t "$SESSION".0 >/dev/null                  # land focus on the first face
tmux set-option -t "$SESSION" mouse on >/dev/null 2>&1 || true

echo "mesh-wall: ${#AGENTS[@]} faces (left) + console (right) in tmux '$SESSION' (space=$SPACE: ${AGENTS[*]})" >&2
echo "mesh-wall: teardown -> ./mesh-wall.sh --stop" >&2
if [ -n "${NO_ATTACH:-}" ] || { [ ! -t 1 ] && [ -z "${TMUX:-}" ]; }; then
  echo "mesh-wall: not attaching — run: tmux attach -t $SESSION" >&2
elif [ -n "${TMUX:-}" ]; then
  tmux switch-client -t "$SESSION"
else
  tmux attach -t "$SESSION"
fi
