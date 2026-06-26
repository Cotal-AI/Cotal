#!/usr/bin/env bash
# mesh-face.sh <agent-name> [agent-file] — launch ONE mesh agent rendered as its pixel face.
#
# Thin wrapper over the connector's serve shim (extensions/connector-opencode/dist/serve.js):
# the shim starts a headless `opencode serve` with the Cotal plugin (which joins the mesh and
# creates the agent's session), then attaches the animated face (face-term.mjs) to that session.
# Persona + model come from the agent file's `face:` / `model:` frontmatter.
#
#   env: COTAL_SPACE (demo) · COTAL_SERVERS (nats://127.0.0.1:4222) · MODEL (overrides agent file)
#   teardown: Ctrl-C this pane (the shim tears its server down)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
NAME="$1"
AGENT="${2:-$DIR/agents/$NAME.md}"
CONN="$ROOT/extensions/connector-opencode/dist"
SERVE="$CONN/serve.js"
PLUGIN="$CONN/plugin.bundle.js"
[ -f "$AGENT" ] || { echo "mesh-face: no agent file: $AGENT" >&2; exit 1; }
{ [ -f "$SERVE" ] && [ -f "$PLUGIN" ]; } || { echo "mesh-face: connector not built — run: pnpm build" >&2; exit 1; }

PERSONA="$(grep -m1 '^face:'  "$AGENT" | sed 's/face:[[:space:]]*//' || true)"; PERSONA="${PERSONA:-$NAME}"
MODEL="${MODEL:-$(grep -m1 '^model:' "$AGENT" | sed 's/model:[[:space:]]*//' || true)}"

# serve.js reads COTAL_FACE_PERSONA + COTAL_FACE_BIN to swap its chat TUI for the face viewer;
# the plugin reads COTAL_AGENT_FILE for the persona and joins COTAL_SERVERS in COTAL_SPACE.
# COTAL_OPENCODE_HOME pins the agent's data root (serve.js requires it) — its SQLite DB and
# pidfile live under "$ROOT/.cotal/opencode/<name>".
export COTAL_SPACE="${COTAL_SPACE:-demo}" COTAL_NAME="$NAME" \
  COTAL_SERVERS="${COTAL_SERVERS:-nats://127.0.0.1:4222}" \
  COTAL_AGENT_FILE="$AGENT" COTAL_OPENCODE_HOME="$ROOT" \
  COTAL_FACE_PERSONA="$PERSONA" COTAL_FACE_BIN="$DIR/face-term.mjs" \
  OPENCODE_CONFIG_CONTENT="{\"\$schema\":\"https://opencode.ai/config.json\",\"permission\":\"allow\",\"plugin\":[\"$PLUGIN\"]${MODEL:+,\"model\":\"$MODEL\"}}"

echo "mesh-face: $NAME (face=$PERSONA, model=${MODEL:-default}) → joining space $COTAL_SPACE" >&2
cd "$ROOT" # serve.js keeps the agent's data dir under ./.cotal/opencode/<name>
exec node "$SERVE"
