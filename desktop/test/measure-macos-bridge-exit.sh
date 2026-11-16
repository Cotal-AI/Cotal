#!/bin/bash
# Measures whether the status-watch bridge dies with the desktop app on macOS.
# The Intel and ARM desktop jobs already open the built app in the Dock presence
# step. This cell opens it again, records the cotal-node child whose command is
# "daemon desktop" and whose parent is the app, kills only the app with SIGKILL,
# and requires that bridge pid to be gone within 5 seconds. A surviving bridge
# is the finding: the script records it and changes no product code.
set -euo pipefail
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "$(uname -s)" = Darwin
: "${RUNNER_TEMP:?}"
out="$RUNNER_TEMP/setup-proof/macos-bridge-exit"
mkdir -p "$out"
app=$(find desktop/src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' -print -quit)
test -n "$app"
bin="$app/Contents/MacOS/cotal-desktop"
test -x "$bin"

report="$out/result.json"
write() { printf '%s\n' "$1" > "$report"; }

app_pid=""
cleanup() {
  if [ -n "$app_pid" ] && kill -0 "$app_pid" 2>/dev/null; then kill -KILL "$app_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

/usr/bin/open -n "$app"
app_pid=""
for _ in $(seq 1 40); do
  app_pid=$(pgrep -f "^$bin" | head -n 1 || true)
  if [ -n "$app_pid" ]; then break; fi
  sleep 1
done
test -n "$app_pid"

bridge_pid=""
bridge_command=""
deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$deadline" ]; do
  while IFS= read -r row; do
    child=${row%% *}
    rest=${row#* }
    parent=${rest%% *}
    command=${rest#* }
    if [ "$parent" = "$app_pid" ] && printf '%s\n' "$command" | grep -q 'daemon desktop'; then
      bridge_pid=$child
      bridge_command=$command
      break
    fi
  done < <(ps -axo pid=,ppid=,command=)
  if [ -n "$bridge_pid" ]; then break; fi
  sleep 1
done

if [ -z "$bridge_pid" ]; then
  ps -axo pid=,ppid=,command= > "$out/processes-before.txt"
  write "{\"cell\":\"macos-bridge-exit\",\"head\":\"${GITHUB_SHA:-}\",\"arch\":\"$(uname -m)\",\"appPid\":$app_pid,\"bridge\":null,\"finding\":\"no daemon desktop child of the app within 60 seconds\"}"
  echo 'no status-watch bridge child' >&2
  exit 1
fi

printf '%s\n' "$bridge_command" > "$out/bridge-command.txt"
killed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
kill -KILL "$app_pid"

gone_at=""
survived=true
for _ in $(seq 1 10); do
  sleep 0.5
  if ! kill -0 "$bridge_pid" 2>/dev/null; then
    survived=false
    gone_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    break
  fi
done
if [ "$survived" = true ]; then
  ps -axo pid=,ppid=,command= > "$out/processes-after.txt"
fi
app_alive=false
if kill -0 "$app_pid" 2>/dev/null; then app_alive=true; fi

python3 - "$report" "$app_pid" "$bridge_pid" "$killed_at" "$gone_at" "$survived" "$app_alive" <<'PY'
import json, os, sys
path, app_pid, bridge_pid, killed_at, gone_at, survived, app_alive = sys.argv[1:]
json.dump({
    "cell": "macos-bridge-exit",
    "head": os.environ.get("GITHUB_SHA"),
    "arch": os.uname().machine,
    "appPid": int(app_pid),
    "bridgePid": int(bridge_pid),
    "killedAt": killed_at,
    "bridgeGoneAt": gone_at or None,
    "bridgeSurvived": survived == "true",
    "appAlive": app_alive == "true",
    "boundSeconds": 5,
}, open(path, "w"), indent=2)
PY

if [ "$app_alive" = true ]; then echo 'SIGKILL did not remove the app' >&2; exit 1; fi
if [ "$survived" = true ]; then
  echo "bridge pid $bridge_pid survived SIGKILL of app pid $app_pid" >&2
  exit 1
fi
echo "bridge pid $bridge_pid gone by $gone_at"
app_pid=""
exit 0
