#!/usr/bin/env bash
# mesh-face.sh <agent-name> [agent-file] — launch ONE mesh agent rendered as its pixel face.
#
# Thin wrapper over the example-local launcher (mesh-face.mjs): it starts a headless `opencode serve`
# with the Cotal plugin (which joins the mesh and creates the agent's session), then attaches the
# animated face (face-term.mjs) to that session. The OpenCode connector itself is face-agnostic — face
# rendering is this example's concern, so the example owns the viewer attach.
# Persona + model come from the agent file's `face:` / `model:` frontmatter.
#
#   env: COTAL_SPACE (demo) · COTAL_SERVERS (nats://127.0.0.1:4222) · MODEL (overrides agent file)
#   teardown: Ctrl-C this pane (the shim tears its server down)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
NAME="$1"
AGENT="${2:-$DIR/agents/$NAME.md}"
PLUGIN="$ROOT/extensions/connector-opencode/dist/plugin.bundle.js"
FACE_PLUGIN="$DIR/face-plugin.mjs"   # example-local: registers the face_<mood> expression tools
SHIM="$DIR/mesh-face.mjs"
[ -f "$AGENT" ] || { echo "mesh-face: no agent file: $AGENT" >&2; exit 1; }
[ -f "$PLUGIN" ] || { echo "mesh-face: connector plugin not built — run: pnpm build" >&2; exit 1; }

PERSONA="$(grep -m1 '^face:'  "$AGENT" | sed 's/face:[[:space:]]*//' || true)"; PERSONA="${PERSONA:-$NAME}"
MODEL="${MODEL:-$(grep -m1 '^model:' "$AGENT" | sed 's/model:[[:space:]]*//' || true)}"

# mesh-face.mjs reads FACE_PERSONA + FACE_BIN to attach the face viewer to the agent's session; the
# Cotal plugin (in OPENCODE_CONFIG_CONTENT) reads COTAL_AGENT_FILE for the persona and joins
# COTAL_SERVERS in COTAL_SPACE. COTAL_OPENCODE_HOME pins the agent's data root (the shim requires it)
# — its SQLite DB and pidfile live under "$ROOT/.cotal/opencode/<name>".
export COTAL_SPACE="${COTAL_SPACE:-demo}" COTAL_NAME="$NAME" \
  COTAL_SERVERS="${COTAL_SERVERS:-nats://127.0.0.1:4222}" \
  COTAL_AGENT_FILE="$AGENT" COTAL_OPENCODE_HOME="$ROOT" \
  FACE_PERSONA="$PERSONA" FACE_BIN="$DIR/face-term.mjs" \
  OPENCODE_CONFIG_CONTENT="{\"\$schema\":\"https://opencode.ai/config.json\",\"permission\":\"allow\",\"plugin\":[\"$PLUGIN\",\"$FACE_PLUGIN\"]${MODEL:+,\"model\":\"$MODEL\"}}"

echo "mesh-face: $NAME (face=$PERSONA, model=${MODEL:-default}) → joining space $COTAL_SPACE" >&2
cd "$ROOT" # the shim keeps the agent's data dir under ./.cotal/opencode/<name>
exec node "$SHIM"
