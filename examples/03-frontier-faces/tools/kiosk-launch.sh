#!/usr/bin/env bash
# Start the Frontier Tower kiosk: file server + Chrome kiosk loop.
# Keeps the display awake and relaunches Chrome automatically on crash.
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${KIOSK_URL:-http://127.0.0.1:4097/kiosk-wide.html}"

# Prevent display sleep
caffeinate -d -i &
CAFF=$!

# Start the file server (serves web/ at :4097)
node tools/serve-wall.mjs &
SERVER=$!

cleanup() { kill "$CAFF" "$SERVER" 2>/dev/null; }
trap cleanup INT TERM EXIT

sleep 1  # let the server bind

# Find Chrome or Chromium
CHROME=""
for c in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "$(command -v google-chrome-stable 2>/dev/null)" \
  "$(command -v chromium-browser 2>/dev/null)"; do
  [ -x "$c" ] && { CHROME="$c"; break; }
done

if [ -z "$CHROME" ]; then
  echo "kiosk-launch: Chrome / Chromium not found — open $URL manually" >&2
  wait "$SERVER"
  exit 0
fi

# Kiosk loop — reopen on crash/close
while true; do
  "$CHROME" \
    --kiosk \
    --no-first-run \
    --disable-infobars \
    --noerrdialogs \
    --disable-session-crashed-bubble \
    --disable-restore-session-state \
    --app="$URL" 2>/dev/null || true
  echo "Chrome exited — restarting in 3s…"
  sleep 3
done
