#!/bin/bash
# Checks the cotal command of the Cotal macOS app, as a person meets it: install from the disk
# image, open the app once, a new terminal, an update that replaces the bundle, a cotal that was
# on PATH first still winning, and deleting the app.
# The app and every shell run with a throwaway HOME, so the account's own startup files and app
# settings are never touched. It installs to /Applications/Cotal.app and refuses if that exists.
#
#   check-command-line-macos.sh [--expect present|absent] <Cotal.dmg> [<update Cotal.app.tar.gz or .dmg>]
#
# With no update, the same bundle replaces itself. --expect absent checks a release from before
# the command existed.
set -euo pipefail
expect=present
if [ "${1:-}" = --expect ]; then expect=$2; shift 2; fi
case "$expect" in present | absent) ;; *) echo "--expect takes present or absent" >&2; exit 2 ;; esac
dmg=${1:?usage: check-command-line-macos.sh [--expect present|absent] <Cotal.dmg> [<update .app.tar.gz or .dmg>]}
update=${2:-$1}
app=/Applications/Cotal.app
[ ! -e "$app" ] || { echo "$app exists. Run this on a Mac without Cotal installed." >&2; exit 2; }
work=$(mktemp -d "${TMPDIR:-/tmp}/cotal-command-line.XXXXXX")
home="$work/home"
mkdir -p "$home"
out="${RUNNER_TEMP:-$work}/desktop-command-line"
mkdir -p "$out"
pid=
cleanup() {
  [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  for mount in "$work"/mnt-*; do [ -d "$mount" ] && hdiutil detach "$mount" -quiet 2>/dev/null || true; done
}
trap cleanup EXIT

checks=0 failures=0
check() { checks=$((checks + 1)); if [ "$2" = "$3" ]; then echo "ok   $1"; else failures=$((failures + 1)); echo "FAIL $1: expected [$3], got [$2]"; fi; }
# Extract a bundle from a disk image or an updater archive into $2.
unpack() {
  mkdir -p "$2"
  case "$1" in
    *.dmg)
      local mount
      mount="$work/mnt-$(basename "$2")"; mkdir -p "$mount"
      hdiutil attach "$1" -mountpoint "$mount" -nobrowse -readonly -quiet
      /usr/bin/ditto "$mount/Cotal.app" "$2/Cotal.app"
      hdiutil detach "$mount" -quiet ;;
    *.tar.gz) /usr/bin/tar -xzf "$1" -C "$2" ;;
    *) echo "Pass a .dmg or .app.tar.gz" >&2; exit 2 ;;
  esac
}
version_of() { /usr/bin/plutil -extract CFBundleShortVersionString raw "$1/Contents/Info.plist"; }
shell=$(/usr/bin/dscl . -read "/Users/$(id -un)" UserShell | awk '{print $2}')
# A new Terminal window: a login shell with launchd's PATH, which /etc/zprofile's path_helper builds on.
fresh() {
  env -i HOME="$home" USER="$(id -un)" LOGNAME="$(id -un)" SHELL="$shell" TERM=xterm-256color PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    "$shell" -l -i -c "$1" 2>/dev/null
}
# Open the app once from its installed place, with the throwaway HOME, and wait for its first-run work.
open_once() {
  HOME="$home" "$app/Contents/MacOS/cotal-desktop" > "$out/app-$1.log" 2>&1 &
  pid=$!
  local record="$home/Library/Application Support/ai.cotal.desktop/command-line.json"
  for _ in $(seq 1 60); do [ -f "$record" ] && break; sleep 1; done
  sleep 2
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; pid=
}
lines() { cat "$home"/.zshrc "$home"/.profile "$home"/.bash_profile "$home"/.bash_login "$home"/.bashrc "$home"/.config/fish/conf.d/cotal-app.fish 2>/dev/null | grep -c "$app/Contents/Resources/bin" || true; }

echo "== login shell $shell"
unpack "$dmg" "$work/first"
/usr/bin/ditto "$work/first/Cotal.app" "$app"
open_once first
if [ "$expect" = absent ]; then
  check "the release has no bundled cotal command" "$(test -e "$app/Contents/Resources/bin/cotal" && echo present || echo none)" none
  check "a new login shell finds no cotal" "$(fresh 'command -v cotal || echo none')" none
  check "the bundled CLI itself runs" "$("$app/Contents/MacOS/cotal-node" "$app/Contents/Resources/runtime/dist/cotal.js" --version)" "cotal-ai $(version_of "$app")"
  rm -rf "$app"
  echo "$((checks - failures))/$checks checks passed"; [ "$failures" = 0 ]; exit
fi
installed() {
  check "a new login shell finds the app's cotal after $1" "$(fresh 'command -v cotal')" "$app/Contents/Resources/bin/cotal"
  check "a new login shell runs the app's cotal after $1" "$(fresh 'cotal --version')" "cotal-ai $(version_of "$app")"
  check "a failing cotal command keeps its non-zero exit code after $1" "$(fresh 'cotal no-such-command >/dev/null 2>&1; [ $? -ne 0 ] && echo nonzero')" nonzero
  check "the startup files name the app's bin folder once after $1" "$(lines)" "$( [ "$(basename "$shell")" = bash ] && echo 2 || echo 1)"
}
installed "opening the app once"
open_once again
check "opening the app again adds nothing" "$(lines)" "$( [ "$(basename "$shell")" = bash ] && echo 2 || echo 1)"

echo "== update"
# The updater moves the new bundle into place in one rename and deletes the old one.
unpack "$update" "$work/next"
mv "$app" "$work/old.app" && mv "$work/next/Cotal.app" "$app" && rm -rf "$work/old.app"
installed "the app was replaced"

echo "== a cotal already on PATH"
other="$home/other-bin"
mkdir -p "$other" && printf '#!/bin/sh\necho other-cotal\n' > "$other/cotal" && chmod 755 "$other/cotal"
case "$(basename "$shell")" in
  fish) printf 'fish_add_path --path --prepend %s\n' "$other" > "$home/.config/fish/conf.d/000-other.fish" ;;
  *) for file in "$home/.zshrc" "$home/.profile" "$home/.bashrc"; do [ -f "$file" ] && printf 'export PATH="%s:$PATH"\n' "$other" >> "$file"; done ;;
esac
check "a cotal earlier on PATH keeps running" "$(fresh 'cotal')" other-cotal
rm -rf "$other"

echo "== delete the app"
rm -rf "$app"
check "a new login shell finds no cotal after the app is deleted" "$(fresh 'command -v cotal || echo none')" none

echo "$((checks - failures))/$checks checks passed"
[ "$failures" = 0 ]
