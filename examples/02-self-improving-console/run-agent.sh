#!/usr/bin/env bash
# Launch ONE example-02 agent as a Claude Code session wired into the Cotal mesh.
#
#   run-agent.sh <orchestrator|research|backend|tui-designer>
#
# Loads the connector as a bare MCP server (cotal tools) + lifecycle hooks, turns on
# channel push (wakes idle agents on incoming DM), and injects the role contract as a
# system prompt so the real packages stay free of per-agent CLAUDE.md files.
#
# Headless mode (COTAL_HEADLESS=1, used by the overnight harness): adds
# --dangerously-skip-permissions and feeds the orchestrator the demo GOAL directly.
# Under the manager's PTY runtime the dev-channels prompt is auto-confirmed (see
# implementations/manager/src/runtime/pty.ts), so no cmux key-injection is needed.
set -euo pipefail

role="${1:-}"
case "$role" in
  orchestrator | research | backend | tui-designer | reviewer) ;;
  *)
    echo "usage: run-agent.sh <orchestrator|research|backend|tui-designer|reviewer>" >&2
    exit 1
    ;;
esac

REPO="$(git rev-parse --show-toplevel)"
HERE="$REPO/examples/02-self-improving-console"
CONN="$REPO/extensions/connector-claude-code"
TSX="$REPO/node_modules/.bin/tsx"
CFG="$HERE/.cotal" # git-ignored
SPACE="${COTAL_SPACE:-console}"

# --- generate the MCP + hooks config (idempotent; absolute repo paths) ------
mkdir -p "$CFG"
cat >"$CFG/mcp.json" <<JSON
{
  "mcpServers": {
    "cotal": { "command": "$TSX", "args": ["$CONN/src/mcp.ts"] }
  }
}
JSON

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

# --- per-role working dir (each agent owns one part of the repo) -------------
case "$role" in
  orchestrator) cd "$REPO" ;;
  research)     cd "$HERE/research" ;;
  backend)      cd "$REPO/implementations/cli" ;;
  tui-designer) cd "$REPO/implementations/cli" ;;
  reviewer)     cd "$REPO" ;;
esac

contract="$HERE/agents/$role.md"

# Orchestrator opens with a prompt; workers stay silent and wake on the orchestrator's DMs.
init=()
if [[ "$role" == orchestrator ]]; then
  if [[ -n "${COTAL_HEADLESS:-}" ]]; then
    init=("$(cat "$HERE/GOAL.md")")
  else
    init=("Onboard me (the operator) in <=6 short lines: what this demo is, that I give you ONE goal and you spawn research/backend/tui-designer into their own tabs, that research seeds the SPEC and backend<->tui-designer settle the data contract peer-to-peer. Show me the goal to paste (from GOAL.md). Then STOP and wait — do NOT spawn yet.")
  fi
fi

# cmux only: auto-confirm the dev-channels prompt in worker tabs (skipped headless —
# the PTY runtime confirms there). Skip the orchestrator (a human drives it on stage).
if [[ "$role" != orchestrator && -n "${CMUX_SURFACE_ID:-}" && -n "${CMUX_BUNDLED_CLI_PATH:-}" ]]; then
  ( for _ in {1..6}; do sleep 1; "$CMUX_BUNDLED_CLI_PATH" send-key --surface "$CMUX_SURFACE_ID" enter; done ) >/dev/null 2>&1 &
fi

extra=()
[[ -n "${COTAL_HEADLESS:-}" ]] && extra+=(--dangerously-skip-permissions)

exec env \
  COTAL_SPACE="$SPACE" COTAL_NAME="$role" COTAL_ROLE="$role" COTAL_CHANNEL=1 \
  claude \
    --dangerously-load-development-channels server:cotal \
    --mcp-config "$CFG/mcp.json" \
    --settings "$CFG/settings.json" \
    --strict-mcp-config \
    --append-system-prompt "$(cat "$contract")" \
    ${extra[@]+"${extra[@]}"} \
    ${init[@]+"${init[@]}"}
