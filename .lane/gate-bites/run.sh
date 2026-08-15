#!/usr/bin/env bash
# G1 — does the gate BITE? Run from the worktree root on a clean tree.
#
# Three runs, in this order, all through bin/smoke/shard.mjs (the real CI entry point) with the
# `pnpm` launcher stubbed for every member except the two health suites:
#
#   baseline : the chain as committed        -> expect rc 0, both health suites RUN, chain completes
#   mutant   : the clamp restored in health.ts -> expect rc 1, chain ABORTS at smoke:delivery-health
#   restore  : tree clean again
#
# It REFUSES at 95 if the mutant does not apply — an empty diff means the substitution missed and the
# "mutant" run would have measured the unmutated program.
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
D=.lane/gate-bites
TARGET=packages/core/src/health.ts
export GATE_BITES_REAL="smoke:delivery-health,smoke:delivery-health-live"

chmod +x "$D/shim/pnpm"
git rev-parse HEAD > "$D/base-sha.txt"
date -u >> "$D/base-sha.txt"

run() {                                   # $1 = label
  export GATE_BITES_LOG="$PWD/$D/$1.log"
  : > "$GATE_BITES_LOG"
  ( PATH="$PWD/$D/shim:$PATH" node bin/smoke/shard.mjs 0 1 > "$D/$1.out" 2>&1 )
  echo "rc=$?" > "$D/$1.rc"
}

# ---- BASELINE ------------------------------------------------------------------------------------
run baseline

# ---- MUTANT G1: restore the clamp that reported a future-stamped heartbeat as age 0 ---------------
# The defect the cells were written for: `ageMs: 0` is exactly what a live round-trip produces, so a
# lease stamped in the FUTURE reads as a heartbeat that arrived just now, and sails through the TTL
# gate. Named cells predicted in .lane/gate-bites/prediction.md, committed BEFORE this ran.
perl -0pi -e 's{return \{ value, source, observedAt, ageMs: null, clockSkewMs: -delta \};}{return { value, source, observedAt, ageMs: 0, clockSkewMs: -delta }; // G1 mutant}' "$TARGET"
git diff -- "$TARGET" > "$D/mutant.diff"
[ -s "$D/mutant.diff" ] || { echo "MUTANT DID NOT APPLY — refusing"; exit 95; }

# NON-EQUIVALENCE WITNESS: what an operator SEES for a lease stamped 5s in the future, captured under
# the mutant, before restore. A mutant that only reddens a cell is not proven non-equivalent.
node node_modules/tsx/dist/cli.mjs "$D/witness.mts" > "$D/witness-mutant.txt" 2>&1

run mutant

# ---- RESTORE -------------------------------------------------------------------------------------
git checkout -- "$TARGET"
git diff --quiet -- "$TARGET"; echo "restore-clean.rc=$?" > "$D/restore.rc"

# The same witness on the restored tree — the inverse control for non-equivalence.
node node_modules/tsx/dist/cli.mjs "$D/witness.mts" > "$D/witness-restored.txt" 2>&1

echo "--- verdicts (read from the artifacts, never from a pipe) ---"
for a in baseline mutant; do printf '%-9s %s\n' "$a" "$(cat "$D/$a.rc")"; done
cat "$D/restore.rc"
date -u
