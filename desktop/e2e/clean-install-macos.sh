#!/usr/bin/env bash
set -euo pipefail
[[ ${RUNNER_ENVIRONMENT:-} == github-hosted ]] || { echo 'This test changes only a disposable hosted runner.' >&2; exit 1; }
node_binary=$(command -v node)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$node_binary" "$work/test-driver"
mkdir -p "$work/tmp"
export PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$work/tmp" DESKTOP_DISPOSABLE=1 DO_NOT_TRACK=1
for dir in /opt/homebrew/bin /usr/local/bin; do
  for tool in node nodejs npm npx brew cotal; do
    target="$dir/$tool"
    if [[ -e $target || -L $target ]]; then
      if sudo -n /bin/mv "$target" "$target.disabled-for-cotal-test" 2>/dev/null; then
        printf 'Disabled %s in a login-shell tool directory.\n' "$tool"
      else
        printf 'Could not rename %s in a login-shell tool directory.\n' "$tool"
      fi
    fi
  done
done
for directory in /opt/homebrew /usr/local/Homebrew; do
  if [[ -d $directory ]]; then
    if sudo -n /bin/mv "$directory" "$directory.disabled-for-cotal-test" 2>/dev/null; then
      echo 'Disabled a system Homebrew installation.'
    else
      echo 'Could not rename a system Homebrew installation. It must remain off PATH.'
    fi
  fi
done
for key in $(/usr/bin/env | /usr/bin/awk -F= '/^COTAL_/ {print $1}'); do unset "$key"; done
unset GH_TOKEN
"$work/test-driver" --import tsx desktop/e2e/clean-install.mjs "$@"
