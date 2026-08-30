#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] && [ "$#" -ne 3 ] && [ "$#" -ne 10 ]; then
  echo "usage: verify-shard-inputs.sh <commit> [<shard> <count> [ci <node-path> <node-target> <node-sha> <pnpm-path> <pnpm-target> <pnpm-sha>]]" >&2
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
  /usr/bin/git --no-replace-objects show "$sha:$path" > "$tmp"
  if ! /usr/bin/cmp -s "$tmp" "$path"; then
    echo "tracked shard input changed after checkout: $path" >&2
    exit 2
  fi
done

committed_fragments="$(/usr/bin/git --no-replace-objects ls-tree -r --name-only "$sha" -- bin/smoke/ci-suites.d | /usr/bin/grep '\.txt$' || true)"
working_fragments="$(/usr/bin/find bin/smoke/ci-suites.d -maxdepth 1 -type f -name '*.txt' -printf '%p\n' | /usr/bin/sort)"
if [ "$committed_fragments" != "$working_fragments" ]; then
  echo "tracked shard fragment inventory changed after checkout" >&2
  exit 2
fi
while IFS= read -r path; do
  [ -n "$path" ] || continue
  /usr/bin/git --no-replace-objects show "$sha:$path" > "$tmp"
  if ! /usr/bin/cmp -s "$tmp" "$path"; then
    echo "tracked shard input changed after checkout: $path" >&2
    exit 2
  fi
done <<EOF
$committed_fragments
EOF

if [ "$#" -eq 1 ]; then
  exit 0
fi

if [ "$#" -eq 10 ]; then
  if [ "$4" != "ci" ]; then
    echo "unknown execution profile: $4" >&2
    exit 2
  fi
  node_bin="$5"
  expected_node_target="$6"
  expected_node_sha="$7"
  pnpm_bin="$8"
  expected_pnpm_target="$9"
  expected_pnpm_sha="${10}"
else
  node_bin="$(command -v node || true)"
  pnpm_bin="$(command -v pnpm || true)"
fi

if [ ! -x "$node_bin" ] || [ ! -x "$pnpm_bin" ]; then
  echo "node and pnpm must resolve to executable files" >&2
  exit 2
fi

if [ "$#" -eq 10 ]; then
  case "$node_bin" in
    /opt/hostedtoolcache/node/22.*/*/bin/node) ;;
    *) echo "unexpected CI node path: $node_bin" >&2; exit 2 ;;
  esac
  case "$pnpm_bin" in
    /home/runner/setup-pnpm/node_modules/.bin*/pnpm) ;;
    *) echo "unexpected CI pnpm path: $pnpm_bin" >&2; exit 2 ;;
  esac
  actual_node_target="$(/usr/bin/readlink -f "$node_bin")"
  actual_pnpm_target="$(/usr/bin/readlink -f "$pnpm_bin")"
  actual_node_sha="$(/usr/bin/sha256sum "$actual_node_target" | /usr/bin/cut -d' ' -f1)"
  actual_pnpm_sha="$(/usr/bin/sha256sum "$actual_pnpm_target" | /usr/bin/cut -d' ' -f1)"
  if [ "$actual_node_target" != "$expected_node_target" ] || [ "$actual_node_sha" != "$expected_node_sha" ]; then
    echo "CI node changed after toolchain capture" >&2
    exit 2
  fi
  if [ "$actual_pnpm_target" != "$expected_pnpm_target" ] || [ "$actual_pnpm_sha" != "$expected_pnpm_sha" ]; then
    echo "CI pnpm changed after toolchain capture" >&2
    exit 2
  fi
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
