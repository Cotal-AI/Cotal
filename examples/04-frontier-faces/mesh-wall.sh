#!/usr/bin/env bash
# mesh-wall.sh — one command for the whole demo: start the mesh, spawn a tmux grid of
# mesh faces (one live OpenCode peer each), and open the console on the same space.
#
#   ./mesh-wall.sh                 # curated roster + console
#   ./mesh-wall.sh sven david      # explicit agents (agent-file basenames)
#   ./mesh-wall.sh all             # every agent (capped at 9 panes)
#   ./mesh-wall.sh --fresh         # wipe the space's chat history first, then start (clean slate)
#   ./mesh-wall.sh --stop          # tear it all down AND wipe the space's chat history (clean restart)
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

nats_up() { (exec 3<>/dev/tcp/127.0.0.1/4222) 2>/dev/null; }   # mesh reachable on the default port?
source "$DIR/tools/tmux-brand.sh"                              # brand_tmux(): shared status-bar branding

# --- teardown -----------------------------------------------------------------
if [ "${1:-}" = "--stop" ]; then
  # Wipe the chat history WHILE the mesh is still up (it outlives the tmux session via nohup) so a
  # later start is clean — the history lives in JetStream's store and would otherwise replay.
  if nats_up; then
    echo "mesh-wall: wiping chat history on space '$SPACE'" >&2
    ( cd "$ROOT" && pnpm cotal history clear --force --dms --space "$SPACE" ) >&2 || true
  fi
  tmux kill-session -t "$SESSION" 2>/dev/null && echo "mesh-wall: killed tmux '$SESSION'" >&2 || true
  if [ -f "$PIDFILE" ]; then
    while read -r pid; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done <"$PIDFILE"
    rm -f "$PIDFILE"
    echo "mesh-wall: stopped the mesh it started" >&2
  fi
  rm -rf "$ROOT/.cotal/opencode"/* 2>/dev/null || true   # drop stale per-agent opencode sessions
  exit 0
fi

# --- fresh start: wipe chat history + stale per-agent sessions, then start normally ---
FRESH=
if [ "${1:-}" = "--fresh" ]; then FRESH=1; shift; fi

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

# --- fresh: wipe retained chat history so agents start clean (no replayed chatter) ---
if [ -n "$FRESH" ]; then
  echo "mesh-wall: fresh start — clearing chat history on space '$SPACE'" >&2
  ( cd "$ROOT" && pnpm cotal history clear --force --dms --space "$SPACE" ) >&2 \
    || echo "mesh-wall: (history clear failed — continuing)" >&2
  rm -rf "$ROOT/.cotal/opencode"/* 2>/dev/null || true   # drop stale per-agent opencode sessions
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
FACE0=$(tmux new-session -d -P -F '#{pane_id}' -s "$SESSION" -x "$cols" -y "$lines" bash -c "$(cmd_for 0)")
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

# Full-width signage strip across the top: Cotal wordmark + tagline + a scannable QR to cotal.ai,
# so passers-by can open the site on their phone. `-f -b` spans the whole window width above both
# columns. NO_BANNER=1 skips it; BANNER_HEIGHT overrides the row count (the QR needs ~16 rows).
if [ -z "${NO_BANNER:-}" ]; then
  tmux split-window -v -f -b -l "${BANNER_HEIGHT:-16}" -t "$SESSION" \
    bash -c "exec node $(printf %q "$DIR/tools/brand-banner.mjs")"
fi

brand_tmux "$SESSION"                                        # persistent branded status bar (Cotal · cotal.ai)
tmux select-pane -t "$FACE0" >/dev/null                     # land focus on the first face (stable pane id)
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
