#!/usr/bin/env bash
set -euo pipefail
[[ ${DESKTOP_LAB_DISPOSABLE:-} == 1 && $# == 1 && $1 == /*.dmg ]] || { echo 'Use an assigned Mac lab and pass one absolute disk image path.' >&2; exit 2; }
export DO_NOT_TRACK=1
for key in $(env | awk -F= '/^COTAL_/ {print $1}'); do unset "$key"; done
for tool in node npm brew; do
  if command -v "$tool" >/dev/null; then printf '%s still resolves. Use a clean lab machine.\n' "$tool" >&2; exit 1; fi
done
[[ ! -e /Applications/Cotal.app && ! -e "$HOME/.cotal" ]] || { echo 'Use a lab session without Cotal state.' >&2; exit 1; }
mount=$(mktemp -d)
trap '/usr/bin/hdiutil detach "$mount" >/dev/null 2>&1 || true; rmdir "$mount"' EXIT
/usr/bin/hdiutil verify "$1" >/dev/null
/usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$mount" "$1" >/dev/null
/usr/bin/codesign --verify --deep --strict "$mount/Cotal.app"
/usr/bin/ditto "$mount/Cotal.app" /Applications/Cotal.app
/usr/bin/open /Applications/Cotal.app
printf '1 PASS installed and opened Cotal\nFollow clean-install-lab.md. Do not record the device code.\n'
