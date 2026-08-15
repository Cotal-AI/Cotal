#!/usr/bin/env bash
# M-F5 RE-RUN — baseline and BOTH mutants in ONE run. Run from the worktree root at a clean tree.
#
# Why this exists rather than an edit to M-F5/RESULT.md: that record combined a first run's mutant-A
# number with a second run's baseline. A composite presented as one run is unfalsifiable, because
# nothing in it tells a later reader which halves belong together. One run or no claim.
#
# The original .lane/mutants/M-F5/ artifacts are NOT touched — they are evidence of what that run
# did. This writes to its own directory.
#
# It REFUSES at 95 when a mutant does not apply: an empty diff means the substitution missed and the
# "mutant" run would have measured the unmutated program. That happened on the first attempt at this
# experiment — perl's s/// broke on the decoy path's slashes — and the guard caught it rather than
# reporting a survivor.
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
D=.lane/mutants/M-F5-rerun
TARGET=bin/smoke/ready-card.smoke.ts

# The tree must be clean for the mutated file, or "restore verified" means nothing.
git diff --quiet -- "$TARGET" || { echo "REFUSING: $TARGET is already dirty"; exit 94; }
git rev-parse HEAD > "$D/base-sha.txt"
date -u > "$D/run-started-utc.txt"

DECOY=$(mktemp -d /tmp/mf5r-decoy-XXXXXX); echo "$DECOY" > "$D/decoy-path.txt"

echo "+ pnpm exec tsx $TARGET   (baseline)" > "$D/baseline.out"
pnpm exec tsx "$TARGET" >> "$D/baseline.out" 2>&1; echo "rc=$?" > "$D/baseline.rc"

# --- MUTANT A: move the HOME redirection to an external decoy, nothing else -----------------------
perl -0pi -e 's{  HOME: HOME_D, COTAL_HOME: HOME_D}{  HOME: "'"$DECOY"'", COTAL_HOME: HOME_D}' "$TARGET"
git diff -- "$TARGET" > "$D/mutantA.diff"
[ -s "$D/mutantA.diff" ] || { echo "MUTANT A DID NOT APPLY — refusing"; exit 95; }
echo "+ pnpm exec tsx $TARGET" > "$D/mutantA.out"
pnpm exec tsx "$TARGET" >> "$D/mutantA.out" 2>&1; echo "rc=$?" > "$D/mutantA.rc"
find "$DECOY" -maxdepth 3 > "$D/decoy-witness.txt"   # the observable effect, captured before restore
git checkout -- "$TARGET"
git diff --quiet -- "$TARGET"; echo "restore-clean.rc=$?" > "$D/restoreA.rc"
rm -rf "$DECOY"

# --- MUTANT B: move the WATCHED path onto a directory that provably changes -----------------------
# HOME stays correctly redirected: this mutant never writes outside the scratch. The three
# substitutions track the current source — the operator-home walk is scoped to COTAL_WRITE_MARKERS.
perl -0pi -e 's{^const realHomeBefore = homeFingerprint\(REAL_HOME, COTAL_WRITE_MARKERS\);$}{const realHomeBefore = homeFingerprint(HOME_D, COTAL_WRITE_MARKERS); // M-F5 mutant B}m' "$TARGET"
perl -0pi -e 's{^if \(REAL_HOME === HOME_D\) throw.*$}{}m' "$TARGET"
perl -0pi -e 's{homeFingerprint\(REAL_HOME, COTAL_WRITE_MARKERS\) === realHomeBefore}{homeFingerprint(HOME_D, COTAL_WRITE_MARKERS) === realHomeBefore}' "$TARGET"
git diff -- "$TARGET" > "$D/mutantB.diff"
[ -s "$D/mutantB.diff" ] || { echo "MUTANT B DID NOT APPLY — refusing"; exit 95; }
echo "+ pnpm exec tsx $TARGET" > "$D/mutantB.out"
pnpm exec tsx "$TARGET" >> "$D/mutantB.out" 2>&1; echo "rc=$?" > "$D/mutantB.rc"
git checkout -- "$TARGET"
git diff --quiet -- "$TARGET"; echo "restore-clean.rc=$?" > "$D/restoreB.rc"

date -u > "$D/run-finished-utc.txt"
echo "--- verdicts (read from the artifacts, never from a pipe) ---"
for a in baseline mutantA mutantB; do printf '%-9s %s  %s\n' "$a" "$(cat "$D/$a.rc")" "$(tail -1 "$D/$a.out")"; done
echo "--- named red cells per arm ---"
for a in mutantA mutantB; do echo "$a:"; grep "✗ FAIL" "$D/$a.out" | sed 's/^/    /'; done
echo "--- restores (0 = verified clean) ---"
cat "$D/restoreA.rc" "$D/restoreB.rc"
