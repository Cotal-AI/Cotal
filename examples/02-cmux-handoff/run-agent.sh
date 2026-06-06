#!/usr/bin/env bash
# Launch ONE demo agent as a Claude Code session wired into the Swarl mesh.
#
#   run-agent.sh <orchestrator|todo-api|todo-web|todo-docs>
#
# Loads the connector as a bare MCP server (swarl tools) + lifecycle hooks
# (presence + inbox drain), and turns on channel push so an idle pane wakes
# when a peer messages it. No plugin install / marketplace needed.
set -euo pipefail

role="${1:-}"
case "$role" in
  orchestrator | todo-api | todo-web | todo-docs) ;;
  *)
    echo "usage: run-agent.sh <orchestrator|todo-api|todo-web|todo-docs>" >&2
    exit 1
    ;;
esac

REPO="$(git rev-parse --show-toplevel)"
HERE="$REPO/examples/02-cmux-handoff"
CONN="$REPO/extensions/connector"
TSX="$REPO/node_modules/.bin/tsx"
CFG="$HERE/.swarl" # git-ignored (.swarl/)

# --- generate the MCP + hooks config (idempotent; absolute repo paths) ------
mkdir -p "$CFG"

cat >"$CFG/mcp.json" <<JSON
{
  "mcpServers": {
    "swarl": { "command": "$TSX", "args": ["$CONN/src/mcp.ts"] }
  }
}
JSON

# One hook entry, reused for every lifecycle event the connector cares about.
hook='{"hooks":[{"type":"command","command":"'"$TSX"'","args":["'"$CONN/src/hook.ts"'"]}]}'
cat >"$CFG/settings.json" <<JSON
{
  "hooks": {
    "SessionStart": [ $hook ],
    "UserPromptSubmit": [ $hook ],
    "Notification": [ {"matcher":"permission_prompt|elicitation_dialog","hooks":[{"type":"command","command":"$TSX","args":["$CONN/src/hook.ts"]}]} ],
    "Stop": [ $hook ],
    "StopFailure": [ $hook ],
    "SessionEnd": [ $hook ]
  }
}
JSON

# --- launch claude in the role's repo, wired to the mesh --------------------
cd "$HERE/$role"

# The orchestrator greets the operator on boot (workers start silent — the orchestrator
# drives them). Passed as claude's initial interactive prompt; it onboards, then waits.
init=()
if [[ "$role" == orchestrator ]]; then
  init=("Before anything else, onboard me (the operator) in <=6 short lines: what this demo is, that I drive it by giving you ONE goal, and that you then spawn todo-api/todo-web/todo-docs into their own tabs and auto-route the api->web handoff. Show me the example goal to paste (from your CLAUDE.md). Then STOP and wait for my goal — do NOT spawn yet.")
fi

# Claude shows a blocking "load development channels" confirmation at startup (the
# --dangerously-… flag below) and waits for Enter. Autonomous worker tabs have no human, so
# auto-confirm by injecting Enter into this cmux surface for a few seconds. Skip the orchestrator
# — a human drives it, and a stray Enter could submit their half-typed prompt. Skip when not under
# cmux. Uses the bundled CLI path since bare `cmux` isn't on $PATH inside a surface.
if [[ "$role" != orchestrator && -n "${CMUX_SURFACE_ID:-}" && -n "${CMUX_BUNDLED_CLI_PATH:-}" ]]; then
  ( for _ in {1..6}; do sleep 1; "$CMUX_BUNDLED_CLI_PATH" send-key --surface "$CMUX_SURFACE_ID" enter; done ) >/dev/null 2>&1 &
fi

exec env \
  SWARL_SPACE=todo SWARL_NAME="$role" SWARL_ROLE="$role" SWARL_CHANNEL=1 \
  claude \
    --dangerously-load-development-channels server:swarl \
    --mcp-config "$CFG/mcp.json" \
    --settings "$CFG/settings.json" \
    --strict-mcp-config \
    ${init[@]+"${init[@]}"}
