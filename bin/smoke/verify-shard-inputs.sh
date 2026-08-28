#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: verify-shard-inputs.sh <commit>" >&2
  exit 2
fi

sha="$1"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

for path in \
  bin/smoke/ci-suites.txt \
  bin/smoke/ci-suites.mjs \
  bin/smoke/shard.mjs \
  bin/smoke/reap-smoke-brokers.mjs \
  package.json \
  pnpm-workspace.yaml
do
  git show "$sha:$path" > "$tmp"
  if ! cmp -s "$tmp" "$path"; then
    echo "tracked shard input changed after checkout: $path" >&2
    exit 2
  fi
done
