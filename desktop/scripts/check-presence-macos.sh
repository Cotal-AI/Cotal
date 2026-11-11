#!/bin/bash
set -euo pipefail
: "${RUNNER_TEMP:?}"
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
out="$RUNNER_TEMP/desktop-presence"
mkdir -p "$out"
dmg=$(find desktop/src-tauri/target/release/bundle/dmg -name '*.dmg' -print -quit)
test -n "$dmg"
mount="$RUNNER_TEMP/cotal-presence-volume"
mkdir "$mount"
app=/Applications/Cotal.app
test ! -e "$app"
cleanup() {
  if test -n "${menu_press_pid:-}"; then kill "$menu_press_pid" 2>/dev/null || true; wait "$menu_press_pid" 2>/dev/null || true; fi
  /usr/bin/osascript -e 'tell application id "ai.cotal.desktop" to quit' 2>/dev/null || true
  hdiutil detach "$mount" -quiet 2>/dev/null || true
}
trap cleanup EXIT
hdiutil attach "$dmg" -mountpoint "$mount" -nobrowse -quiet
# Record the actual mounted layout, not just tauri.conf.json.
/usr/bin/osascript - "$mount" <<'APPLESCRIPT' > "$out/dmg-layout.txt"
on run argv
  tell application "Finder"
    set diskFolder to POSIX file (item 1 of argv) as alias
    open diskFolder
    set w to container window of diskFolder
    set current view of w to icon view
    set appLocation to position of item "Cotal.app" of diskFolder
    set applicationsLocation to position of item "Applications" of diskFolder
    if item 1 of appLocation is greater than item 1 of applicationsLocation then error "DMG app is not left of Applications"
    get {bounds of w, appLocation, applicationsLocation}
  end tell
end run
APPLESCRIPT
/usr/sbin/screencapture -x "$out/dmg-layout.png"
/usr/bin/ditto "$mount/Cotal.app" "$app"
hdiutil detach "$mount" -quiet
/usr/bin/open "$app"
for i in $(seq 1 40); do
  if pgrep -f '^/Applications/Cotal.app/Contents/MacOS/cotal-desktop' > /dev/null; then break; fi
  sleep 1
done
pid=$(pgrep -f '^/Applications/Cotal.app/Contents/MacOS/cotal-desktop')
/usr/bin/lsappinfo info -only applicationtype,hidden,visible,name "pid=$pid" | tee "$out/application.txt"
# NSRunningApplication's public activationPolicy and CGWindowList independently verify foreground type and a window.
cat > "$out/query.swift" <<'SWIFT'
import AppKit
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "ai.cotal.desktop")
guard apps.count == 1, apps[0].activationPolicy == .regular else { fatalError("Cotal is not one regular Dock application") }
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
guard windows.contains(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == apps[0].processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }) else { fatalError("No visible Cotal window") }
print("regular activation policy and visible top-level window", apps[0].processIdentifier)
SWIFT
sleep 4
swift "$out/query.swift" | tee "$out/visible-before.txt"
/usr/sbin/screencapture -x "$out/dock-open.png"
# Accessibility is required, never silently skip a missing desktop permission.
/usr/bin/osascript <<'APPLESCRIPT'
tell application "System Events"
  tell process "cotal-desktop"
    click button 1 of window 1
  end tell
end tell
APPLESCRIPT
sleep 1
# The first close explains hide-to-tray and remains visible. The second closes it.
/usr/bin/osascript <<'APPLESCRIPT'
tell application "System Events"
  tell process "cotal-desktop"
    if exists window 1 then click button 1 of window 1
  end tell
end tell
APPLESCRIPT
sleep 2
cat > "$out/hidden.swift" <<'SWIFT'
import AppKit
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "ai.cotal.desktop")
guard apps.count == 1 else { fatalError("Close terminated the app rather than hiding it") }
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
guard !windows.contains(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == apps[0].processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }) else { fatalError("Close did not hide the Cotal window") }
print("close kept app running with no visible top-level window")
SWIFT
swift "$out/hidden.swift" | tee "$out/hidden-before-reopen.txt"
# NSStatusItem's accessibility press can wait until the menu closes. Inspect from
# another process while the lane-owned press is still pending.
/usr/bin/osascript <<'APPLESCRIPT' > "$out/menu-press.txt" 2>&1 &
tell application "System Events"
  tell process "cotal-desktop"
    perform action "AXPress" of menu bar item 1 of menu bar 2
  end tell
end tell
APPLESCRIPT
menu_press_pid=$!
sleep 2
/usr/sbin/screencapture -x "$out/menu-bar-open.png"
/usr/bin/osascript <<'APPLESCRIPT' > "$out/menu-bar-tree.txt"
tell application "System Events"
  tell process "cotal-desktop"
    get entire contents
  end tell
end tell
APPLESCRIPT
/usr/bin/osascript <<'APPLESCRIPT' > "$out/menu-bar.txt"
tell application "System Events"
  tell process "cotal-desktop"
    set titles to name of every menu item of menu 1 of menu bar item 1 of menu bar 2
    repeat with requiredTitle in {"Settings…", "Open dashboard", "Quit Cotal"}
      if titles does not contain (requiredTitle as text) then error "Missing tray menu action: " & requiredTitle
    end repeat
    return titles
  end tell
end tell
APPLESCRIPT
/usr/bin/osascript <<'APPLESCRIPT'
tell application "System Events"
  tell process "cotal-desktop"
    click menu item "Settings…" of menu 1 of menu bar item 1 of menu bar 2
  end tell
end tell
APPLESCRIPT
wait "$menu_press_pid"
menu_press_pid=
sleep 2
swift "$out/query.swift" | tee "$out/visible-after-settings.txt"
/usr/bin/osascript <<'APPLESCRIPT'
tell application "System Events"
  tell process "cotal-desktop" to click button 1 of window 1
end tell
APPLESCRIPT
sleep 2
swift "$out/hidden.swift" | tee "$out/hidden-after-settings.txt"
/usr/bin/osascript -e 'tell application id "ai.cotal.desktop" to reopen'
sleep 2
swift "$out/query.swift" | tee "$out/visible-after-reopen.txt"
/usr/sbin/screencapture -x "$out/dock-reopened.png"
/usr/bin/osascript -e 'tell application id "ai.cotal.desktop" to quit'
for i in $(seq 1 20); do if ! kill -0 "$pid" 2>/dev/null; then break; fi; sleep 1; done
if kill -0 "$pid" 2>/dev/null; then echo 'Dock/application Quit did not terminate Cotal'; exit 1; fi
# First-open disconnected setting must not install an app login entry.
if find "$HOME/Library/LaunchAgents" -maxdepth 1 -iname '*Cotal*' -print 2>/dev/null | /usr/bin/grep -q .; then
  echo 'Unexpected app login entry after disconnected first open'; exit 1
fi
/usr/bin/open "$app" --args --background
sleep 4
cat > "$out/background.swift" <<'SWIFT'
import AppKit
let app = NSRunningApplication.runningApplications(withBundleIdentifier: "ai.cotal.desktop")
guard app.count == 1, app[0].activationPolicy == .regular else { fatalError("Background app missing Dock identity") }
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
guard !windows.contains(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == app[0].processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }) else { fatalError("Background launch showed a window") }
print("background launch kept window hidden")
SWIFT
swift "$out/background.swift" | tee "$out/background.txt"
/usr/bin/osascript -e 'tell application id "ai.cotal.desktop" to quit'
printf '{"platform":"macOS","architecture":"%s","result":"passed","checks":["dmg-install","layout-recorded","regular-activation","visible-window","close-hidden","menu-bar-actions","settings-restore","reopen","quit","disconnected-login-absent","background-hidden"]}\n' "$(uname -m)" > "$out/result.json"
