#!/usr/bin/env bash
# M-F5 — the exact sequence, re-runnable. Run from the worktree root at a clean tree.
#
# It REFUSES at 95 when a mutant does not apply: an empty diff means the substitution missed and the
# "mutant" run would have measured the unmutated program. That happened on the first attempt here —
# perl's `s///` broke on the decoy path's slashes, the file was never written, and the guard caught
# it rather than reporting a survivor.
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
D=.lane/mutants/M-F5
TARGET=bin/smoke/ready-card.smoke.ts
git rev-parse HEAD > "$D/base-sha.txt"
DECOY=$(mktemp -d /tmp/mf5-decoy-XXXXXX); echo "$DECOY" > "$D/decoy-path.txt"

echo "+ pnpm exec tsx $TARGET   (baseline)" > "$D/baseline.out"
pnpm exec tsx "$TARGET" >> "$D/baseline.out" 2>&1; echo "rc=$?" > "$D/baseline.rc"

# --- MUTANT A: move the HOME redirection to an external decoy, nothing else -----------------------
perl -0pi -e 's{  HOME: HOME_D, COTAL_HOME: HOME_D}{  HOME: "'"$DECOY"'", COTAL_HOME: HOME_D}' "$TARGET"
git diff -- "$TARGET" > "$D/mutantA.diff"
[ -s "$D/mutantA.diff" ] || { echo "MUTANT A DID NOT APPLY — refusing"; exit 95; }
echo "+ pnpm exec tsx $TARGET" > "$D/mutantA.out"
pnpm exec tsx "$TARGET" >> "$D/mutantA.out" 2>&1; echo "rc=$?" > "$D/mutantA.rc"
find "$DECOY" -maxdepth 2 > "$D/decoy-witness.txt"   # the observable effect, captured before restore
git checkout -- "$TARGET"
git diff --quiet -- "$TARGET"; echo "restore-clean.rc=$?" > "$D/restoreA.rc"
rm -rf "$DECOY"

# --- MUTANT B: move the WATCHED path onto a directory that provably changes -----------------------
# HOME stays correctly redirected: this mutant never writes outside the scratch.
perl -0pi -e 's{^const realHomeBefore = homeFingerprint\(REAL_HOME\);$}{const realHomeBefore = homeFingerprint(HOME_D); // M-F5 mutant B}m' "$TARGET"
perl -0pi -e 's{^if \(REAL_HOME === HOME_D\) throw.*$}{}m' "$TARGET"
perl -0pi -e 's{homeFingerprint\(REAL_HOME\) === realHomeBefore}{homeFingerprint(HOME_D) === realHomeBefore}' "$TARGET"
git diff -- "$TARGET" > "$D/mutantB.diff"
[ -s "$D/mutantB.diff" ] || { echo "MUTANT B DID NOT APPLY — refusing"; exit 95; }
echo "+ pnpm exec tsx $TARGET" > "$D/mutantB.out"
pnpm exec tsx "$TARGET" >> "$D/mutantB.out" 2>&1; echo "rc=$?" > "$D/mutantB.rc"
git checkout -- "$TARGET"
git diff --quiet -- "$TARGET"; echo "restore-clean.rc=$?" > "$D/restoreB.rc"

grep -c . /dev/null >/dev/null 2>&1 || true
echo "--- verdicts (read from the artifacts, never from a pipe) ---"
for a in baseline mutantA mutantB; do printf '%-9s %s  %s\n' "$a" "$(cat "$D/$a.rc")" "$(tail -1 "$D/$a.out")"; done
cat "$D/restoreA.rc" "$D/restoreB.rc"
