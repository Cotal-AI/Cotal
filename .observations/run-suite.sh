#!/usr/bin/env bash
# Scoped suite runner. NOT A GATE — two named suites only, and it says so.
#
# Real exit codes come from an EXIT-trap artifact, never from a pipe: `cmd | tee` reports tee's
# status, and this lane exists to refuse exactly that kind of substituted evidence.
#
# Usage: run-suite.sh <pnpm-script-name> <artifact-prefix>
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"

SCRIPT="$1"
PREFIX="$2"
OUT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$OUT_DIR/${PREFIX}.log"
RC_FILE="$OUT_DIR/${PREFIX}.rc"
MARKER="$OUT_DIR/${PREFIX}.marker"

rm -f "$RC_FILE" "$MARKER"

# The rc artifact is written on EVERY exit path, including a kill. An absent .rc is therefore
# distinguishable from a failing one — absence means KILLED, not FAILED.
rc=127
trap 'echo "$rc" > "$RC_FILE"; echo "SUITE-END script=$SCRIPT rc=$rc at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MARKER"' EXIT

{
  echo "SUITE-BEGIN script=$SCRIPT at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "node=$(node -v)  head=$(git rev-parse HEAD)"
  echo "NOT A GATE: this is one scoped suite."
} > "$LOG"

cd "$OUT_DIR/.." || exit 1
pnpm "$SCRIPT" >> "$LOG" 2>&1
rc=$?
exit $rc
