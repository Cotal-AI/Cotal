#!/usr/bin/env bash
# compare-headers.sh — preview the signage header layouts side by side to pick one.
# Opens a tmux session with one window per layout (Card / Bar / Hero); switch with Ctrl-b 1/2/3.
#
#   ./tools/compare-headers.sh                 # default blue glow
#   ./tools/compare-headers.sh cyan            # try another QR colour (cyan|blue|white|magenta|#hex)
#
# Teardown: Ctrl-b & in tmux, or `tmux kill-session -t header-compare`.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COLOR="${1:-blue}"
S="header-compare"

command -v tmux >/dev/null || { echo "compare-headers: tmux not found" >&2; exit 1; }
banner() { printf 'exec node %q/tools/brand-banner.mjs --variant %s --qr-color %q' "$DIR" "$1" "$COLOR"; }

tmux kill-session -t "$S" 2>/dev/null || true
# bash -c so the command isn't fed to a nu/fish default-shell.
tmux new-session -d -s "$S" -n "1-Card" bash -c "$(banner 1)"
tmux new-window  -t "$S"    -n "2-Bar"  bash -c "$(banner 2)"
tmux new-window  -t "$S"    -n "3-Hero" bash -c "$(banner 3)"
tmux select-window -t "$S:1"

echo "compare-headers: Ctrl-b 1/2/3 to switch layouts (QR colour: $COLOR)" >&2
if [ -n "${NO_ATTACH:-}" ] || { [ ! -t 1 ] && [ -z "${TMUX:-}" ]; }; then
  echo "compare-headers: not attaching — run: tmux attach -t $S" >&2
elif [ -n "${TMUX:-}" ]; then
  tmux switch-client -t "$S"
else
  tmux attach -t "$S"
fi
