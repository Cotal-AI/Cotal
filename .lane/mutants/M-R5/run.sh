#!/usr/bin/env bash
# M-R5: apply the mutant by hand, run BOTH suites, restore, verify the restore.
#
# mutation-proof already killed this mutant against the new behavioural suite. This run exists for
# the OTHER half of the prediction: that the STRUCTURAL shell cells stay fully green against the
# same mutant, because they scan `managerRow` and the mutant is one call below it. That blindness is
# the reviewer's finding, and demonstrating it is what shows the new suite closed a real hole rather
# than an imagined one.
#
# Every exit code here is read from a FILE written by the command itself, never from a pipe.
set -u
cd "$(dirname "$0")/../../.." || exit 95
REPO=$PWD
ART="$REPO/.lane/mutants/M-R5"
TARGET="implementations/cli/src/lib/manager-proc.ts"
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"

# Refuse on a dirty tree: git has to be the recovery, not this script.
[ -z "$(git status --porcelain)" ] || { echo "REFUSE(95): dirty tree"; exit 95; }
git rev-parse HEAD > "$ART/base-sha.txt"
date -u > "$ART/started-at.txt"

# The repair cells take their artifact directory from ART_DIR and REFUSE (`${ART_DIR:?}`) without
# it. The first version of this runner did not set it, so both repair arms died at line 17 having
# run nothing — and each exited 1, which read alone looks exactly like "the structural suite went
# red on the mutant". That is the opposite of the truth and it flatters the mutant. So the rc is
# never taken from the command here: it is taken from the artifact the suite stamps itself, and a
# missing stamp is reported as NOT MEASURED rather than as any verdict.
export ART_DIR="$ART/repair-artifacts"
mkdir -p "$ART_DIR"

# Read a repair run's real result, or say plainly that there is none.
repair_verdict() {
  local label=$1
  if [ -f "$ART_DIR/finding5-repair.rc" ]; then
    echo "$label: rc=$(cat "$ART_DIR/finding5-repair.rc") marker=$(head -1 "$ART_DIR/finding5-repair.marker" 2>/dev/null)"
  else
    echo "$label: NOT MEASURED — the suite never reached its own stamp"
  fi
}

FIND='return { state: probe(pid), pid, raw };'
REPL='const st = probe(pid); const raw2 = readFileSync(p, "utf8").trim(); return { state: st, pid: parsePid(raw2), raw: raw2 };'

python3 - "$TARGET" "$FIND" "$REPL" <<'PY' || exit 95
import sys
p, find, repl = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
n = s.count(find)
if n != 1:
    print(f"REFUSE: target occurs {n} times, need exactly 1"); sys.exit(1)
open(p, "w").write(s.replace(find, repl))
PY

git diff > "$ART/mutant.diff"

( cd implementations/cli && tsc -p tsconfig.json ) > "$ART/build.log" 2>&1
echo $? > "$ART/build.rc"

pnpm smoke:liveness-snapshot > "$ART/mutant-liveness.out" 2>&1
echo $? > "$ART/mutant-liveness.rc"

rm -f "$ART_DIR/finding5-repair.rc" "$ART_DIR/finding5-repair.marker"
bash .lane/finding5-repair-cells.sh > "$ART/mutant-repair.out" 2>&1
echo $? > "$ART/mutant-repair.shell-rc"
repair_verdict "MUTANT REPAIR" > "$ART/mutant-repair.verdict"

# ---- restore, and PROVE the restore ------------------------------------------------------------
git checkout -- "$TARGET"
git diff --quiet HEAD; echo $? > "$ART/restore-clean.rc"   # 0 == tree matches HEAD again
( cd implementations/cli && tsc -p tsconfig.json ) > "$ART/restore-build.log" 2>&1
echo $? > "$ART/restore-build.rc"

pnpm smoke:liveness-snapshot > "$ART/restore-liveness.out" 2>&1
echo $? > "$ART/restore-liveness.rc"

rm -f "$ART_DIR/finding5-repair.rc" "$ART_DIR/finding5-repair.marker"
bash .lane/finding5-repair-cells.sh > "$ART/restore-repair.out" 2>&1
echo $? > "$ART/restore-repair.shell-rc"
repair_verdict "RESTORE REPAIR" > "$ART/restore-repair.verdict"

date -u > "$ART/finished-at.txt"
echo "M-R5 done. rc files under $ART"
