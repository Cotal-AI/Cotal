#!/bin/bash
# Checks the cotal command a Cotal deb or rpm installs, as a person meets it: install, a new login
# shell, an update, removal, and a /usr/bin/cotal from another installation left alone.
# Runs as root in a disposable container or runner. It installs and removes the package.
#
#   check-command-line-linux.sh [--expect present|absent] <package> [<update package>]
#
# With no update package, the same package is installed again over itself. --expect absent checks
# a release from before the command existed: installing it leaves cotal off PATH.
set -euo pipefail
expect=present
if [ "${1:-}" = --expect ]; then expect=$2; shift 2; fi
case "$expect" in present | absent) ;; *) echo "--expect takes present or absent" >&2; exit 2 ;; esac
first=${1:?usage: check-command-line-linux.sh [--expect present|absent] <package> [<update package>]}
update=${2:-$1}
[ "$(id -u)" = 0 ] || { echo "Run as root in a disposable container or runner." >&2; exit 2; }
[ -f /.dockerenv ] || [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || { echo "This installs and removes Cotal: run it only in a disposable container or runner." >&2; exit 2; }

checks=0 failures=0
check() { checks=$((checks + 1)); if [ "$2" = "$3" ]; then echo "ok   $1"; else failures=$((failures + 1)); echo "FAIL $1: expected [$3], got [$2]"; fi; }
case "$first" in
  *.deb)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null
    apt-get install -y -qq passwd util-linux >/dev/null
    install_pkg() { apt-get install -y -qq --allow-downgrades --reinstall "$1" 2>&1 | grep -v -E '^(Selecting|Preparing|Unpacking|Setting up|Processing|\(Reading)' || true; }
    version_of() { dpkg-deb -f "$1" Version; }
    remove_pkg() { apt-get remove -y -qq cotal >/dev/null 2>&1; }
    ;;
  *.rpm)
    dnf install -y -q util-linux shadow-utils >/dev/null
    install_pkg() { if rpm -q "$(rpm -qp --qf '%{NAME}' "$1")" >/dev/null 2>&1; then dnf reinstall -y -q "$1" 2>&1 || dnf install -y -q "$1" 2>&1; else dnf install -y -q "$1" 2>&1; fi; }
    version_of() { rpm -qp --qf '%{VERSION}' "$1"; }
    remove_pkg() { dnf remove -y -q "$(rpm -qp --qf '%{NAME}' "$first")" >/dev/null 2>&1; }
    ;;
  *) echo "Pass a .deb or .rpm package." >&2; exit 2 ;;
esac
id cotal-check >/dev/null 2>&1 || useradd -m -s /bin/bash cotal-check
# A new terminal: a login shell of an ordinary user.
fresh() { runuser -l cotal-check -c "$1" 2>&1; }

echo "== install $(basename "$first")"
install_pkg "$first"
if [ "$expect" = absent ]; then
  check "a new login shell finds no cotal" "$(fresh 'command -v cotal || echo none')" none
  check "a new login shell cannot run cotal" "$(fresh 'cotal --version >/dev/null 2>&1; echo $?')" 127
  check "the bundled CLI itself runs" "$(fresh '/usr/bin/cotal-node /usr/lib/Cotal/runtime/dist/cotal.js --version')" "cotal-ai $(version_of "$first")"
  remove_pkg
  echo "$((checks - failures))/$checks checks passed"; [ "$failures" = 0 ]; exit
fi
installed() {
  check "/usr/bin/cotal links to the app's command after $1" "$(readlink /usr/bin/cotal)" /usr/lib/Cotal/bin/cotal
  check "the app's command is executable after $1" "$(stat -c %a /usr/lib/Cotal/bin/cotal)" 755
  check "a new login shell finds cotal after $1" "$(fresh 'command -v cotal')" /usr/bin/cotal
  check "a new login shell runs the app's cotal after $1" "$(fresh 'cotal --version')" "cotal-ai $2"
}
installed install "$(version_of "$first")"

echo "== update to $(basename "$update")"
install_pkg "$update"
installed update "$(version_of "$update")"

echo "== remove"
remove_pkg
check "removal deletes /usr/bin/cotal" "$(test -e /usr/bin/cotal || test -L /usr/bin/cotal && echo present || echo gone)" gone
check "a new login shell finds no cotal after removal" "$(fresh 'command -v cotal || echo none')" none

echo "== /usr/bin/cotal from another installation (npm with a /usr prefix)"
printf '#!/bin/sh\necho other-cotal\n' > /usr/bin/cotal && chmod 755 /usr/bin/cotal
before=$(sha256sum /usr/bin/cotal)
said=$(install_pkg "$update" 2>&1)
check "install names the other cotal it left" "$(printf '%s' "$said" | grep -c 'belongs to another installation and was left as it is')" 1
check "install leaves the other /usr/bin/cotal unchanged" "$(sha256sum /usr/bin/cotal)" "$before"
check "the other cotal still runs" "$(fresh 'cotal')" other-cotal
check "the app's command runs by its own path" "$(fresh '/usr/lib/Cotal/bin/cotal --version')" "cotal-ai $(version_of "$update")"
remove_pkg
check "removal leaves the other /usr/bin/cotal unchanged" "$(sha256sum /usr/bin/cotal 2>/dev/null || echo gone)" "$before"
rm -f /usr/bin/cotal

echo "$((checks - failures))/$checks checks passed"
[ "$failures" = 0 ]
