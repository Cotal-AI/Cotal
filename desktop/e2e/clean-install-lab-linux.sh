#!/usr/bin/env bash
set -euo pipefail
[[ ${DESKTOP_LAB_DISPOSABLE:-} == 1 && $# == 1 ]] || { echo 'Use an assigned desktop lab machine and pass one installer path.' >&2; exit 2; }
export DO_NOT_TRACK=1
for key in $(env | awk -F= '/^COTAL_/ {print $1}'); do unset "$key"; done
for tool in node npm; do
  if command -v "$tool" >/dev/null; then printf '%s still resolves. Use a clean lab machine.\n' "$tool" >&2; exit 1; fi
done
case "$1" in
  /*.deb) sudo apt-get install -y "$1" ;;
  /*.rpm) sudo dnf install -y "$1" ;;
  *) echo 'Pass an absolute path to a Debian or RPM installer.' >&2; exit 2 ;;
esac
test -x /usr/bin/cotal-desktop
/usr/bin/cotal-desktop >/dev/null 2>&1 &
printf '1 PASS installed and opened Cotal\nFollow clean-install-lab.md. Do not record the device code.\n'
