#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] && [ "$#" -ne 3 ] && [ "$#" -ne 4 ]; then
  echo "usage: verify-shard-inputs.sh <commit> [<shard> <count> [ci]]" >&2
  exit 2
fi

sha="$1"
tmp="$(/usr/bin/mktemp)"
trap '/bin/rm -f "$tmp"' EXIT

for path in \
  bin/smoke/ci-suites.txt \
  bin/smoke/ci-suites.mjs \
  bin/smoke/shard.mjs \
  bin/smoke/reap-smoke-brokers.mjs \
  package.json \
  pnpm-workspace.yaml
do
  /usr/bin/git show "$sha:$path" > "$tmp"
  if ! /usr/bin/cmp -s "$tmp" "$path"; then
    echo "tracked shard input changed after checkout: $path" >&2
    exit 2
  fi
done

if [ "$#" -eq 1 ]; then
  exit 0
fi

node_bin="$(command -v node || true)"
pnpm_bin="$(command -v pnpm || true)"
if [ ! -x "$node_bin" ] || [ ! -x "$pnpm_bin" ]; then
  echo "node and pnpm must resolve to executable files" >&2
  exit 2
fi
if [ "$#" -eq 4 ]; then
  if [ "$4" != "ci" ]; then
    echo "unknown execution profile: $4" >&2
    exit 2
  fi
  case "$node_bin" in
    /opt/hostedtoolcache/node/22.*/*/bin/node) ;;
    *) echo "unexpected CI node path: $node_bin" >&2; exit 2 ;;
  esac
  case "$pnpm_bin" in
    /home/runner/setup-pnpm/node_modules/.bin*/pnpm) ;;
    *) echo "unexpected CI pnpm path: $pnpm_bin" >&2; exit 2 ;;
  esac
fi

node_dir="${node_bin%/*}"
pnpm_dir="${pnpm_bin%/*}"
workspace="$(/bin/pwd -P)"
clean_path="$pnpm_dir:$node_dir:/home/runner/nats-bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

exec /usr/bin/env -i \
  PATH="$clean_path" \
  HOME=/home/runner \
  USER=runner \
  LOGNAME=runner \
  SHELL=/usr/bin/bash \
  TMPDIR=/tmp \
  TMP=/tmp \
  TEMP=/tmp \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  CI=true \
  GITHUB_ACTIONS=true \
  GITHUB_WORKSPACE="$workspace" \
  RUNNER_TEMP=/tmp \
  RUNNER_OS=Linux \
  RUNNER_ARCH=X64 \
  "$node_bin" bin/smoke/shard.mjs "$2" "$3"
