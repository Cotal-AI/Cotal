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
reuse=false
if [ -e "$app" ]; then
  # The E2E workflow already installed and stopped this package for its launch proof.
  # Main's package-only workflow still requires an absent destination below.
  node --input-type=module - "$RUNNER_TEMP/desktop-launch/result.json" <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const proof = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(proof.outcome, 'passed');
assert.equal(proof.binary, '/Applications/Cotal.app/Contents/MacOS/cotal-desktop');
assert.ok(proof.captures.some(row => row.target === 'applications'));
assert.equal(proof.installedSha256, createHash('sha256').update(readFileSync(proof.binary)).digest('hex'));
NODE
  if pgrep -f '^/Applications/Cotal.app/Contents/MacOS/cotal-desktop$' > /dev/null; then
    echo 'Prior installed launch proof left its app running'; exit 1
  fi
  reuse=true
fi
cleanup() {
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
if [ "$reuse" = false ]; then /usr/bin/ditto "$mount/Cotal.app" "$app"; fi
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
guard apps[0].isActive else { fatalError("Shown Cotal application did not regain focus") }
print("regular activation policy, active application and visible top-level window", apps[0].processIdentifier)
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
print("activation policy after close:", apps[0].activationPolicy.rawValue)
guard apps[0].activationPolicy == .accessory else { fatalError("Closed Cotal window left a Dock application instead of a menu-bar-only accessory") }
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
guard !windows.contains(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == apps[0].processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }) else { fatalError("Close did not hide the Cotal window") }
print("close kept app running with no visible top-level window")
SWIFT
swift "$out/hidden.swift" | tee "$out/hidden-before-reopen.txt"
# tray-icon handles mouseDown on its custom subview, not AXPress on the parent
# NSStatusBarButton. Derive coordinates from AX and send a real desktop click.
/usr/bin/osascript <<'APPLESCRIPT' > "$out/menu-position.txt"
tell application "System Events"
  tell process "cotal-desktop"
    set p to position of menu bar item 1 of last menu bar
    set s to size of menu bar item 1 of last menu bar
    set x to ((item 1 of p) + (item 1 of s) / 2) as text
    set y to ((item 2 of p) + (item 2 of s) / 2) as text
    return x & "," & y
  end tell
end tell
APPLESCRIPT
cat > "$out/menu-click.swift" <<'SWIFT'
import CoreGraphics
import Foundation
let values = CommandLine.arguments[1].split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
guard values.count == 2 else { fatalError("No unique status-item center") }
let point = CGPoint(x: values[0], y: values[1])
for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { fatalError("Mouse event unavailable") }
    event.post(tap: .cghidEventTap)
    usleep(100_000)
}
SWIFT
swift "$out/menu-click.swift" "$(cat "$out/menu-position.txt")"
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
    set titles to name of every menu item of menu 1 of menu bar item 1 of last menu bar
    repeat with requiredTitle in {"Settings…", "Open dashboard", "Quit app (computer stays connected)"}
      if titles does not contain (requiredTitle as text) then error "Missing tray menu action: " & requiredTitle
    end repeat
    return titles
  end tell
end tell
APPLESCRIPT
/usr/bin/osascript <<'APPLESCRIPT'
tell application "System Events"
  tell process "cotal-desktop"
    click menu item "Settings…" of menu 1 of menu bar item 1 of last menu bar
  end tell
end tell
APPLESCRIPT
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
guard app.count == 1, app[0].activationPolicy == .accessory else { fatalError("Background app retained a Dock icon") }
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
guard !windows.contains(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == app[0].processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }) else { fatalError("Background launch showed a window") }
print("background launch kept window hidden with accessory activation policy")
SWIFT
swift "$out/background.swift" | tee "$out/background.txt"
# LaunchServices is the same reopen path used by Finder and Spotlight.
/usr/bin/open "$app"
sleep 2
swift "$out/query.swift" | tee "$out/visible-after-background-reopen.txt"
/usr/bin/osascript <<'APPLESCRIPT'
tell application "System Events"
  tell process "cotal-desktop" to click button 1 of window 1
end tell
APPLESCRIPT
sleep 2
swift "$out/hidden.swift" | tee "$out/hidden-before-link.txt"
/usr/bin/open 'cotal://connect?idp=https%3A%2F%2Fexample.com&space=presence-check'
sleep 2
swift "$out/query.swift" | tee "$out/visible-after-link.txt"
/usr/bin/osascript <<'APPLESCRIPT' > "$out/restored-app-menu.txt"
tell application "System Events"
  tell process "cotal-desktop"
    if not frontmost then error "Restored Cotal window is not focused"
    if not (exists menu bar 1) then error "Restored application menu is missing"
    get name of every menu bar item of menu bar 1
  end tell
end tell
APPLESCRIPT
/usr/bin/osascript -e 'tell application id "ai.cotal.desktop" to quit'
printf '{"platform":"macOS","architecture":"%s","result":"passed","checks":["dmg-install","layout-recorded","regular-activation","visible-window","close-hidden-accessory","menu-bar-actions","settings-restore","reopen","quit","disconnected-login-absent","background-hidden-accessory","background-reopen","deep-link-restore","restored-focus-menu"]}\n' "$(uname -m)" > "$out/result.json"
