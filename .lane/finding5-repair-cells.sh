#!/usr/bin/env bash
# Scope 1 repair cells — R2..R7, driven through the REAL `cotal setup` card.
#
# R1 (a real WEDGED manager is never claimed running) is NOT here: it is proved by running the
# untouched pre-fix instrument `.lane/finding5-A-wedge.sh` against the fixed code and observing its
# A4 cell FLIP. That instrument was written before the fix and asserts the OLD behaviour, which makes
# it stronger evidence than a cell written to agree with the repair.
#
# These arms need no broker: the manager row is now a pure function of `managerLiveness()`, which
# reads only `.cotal/manager.pid`. Each arm plants a different pidfile state and reads the rendered
# card. Nothing calls `managerLiveness()` directly — a cell asserted on a return value proves the
# function, not the surface.
set -u

pass=0; fail=0   # declared BEFORE the trap: with `set -u`, an exit before these are set
                 # would make the trap that reports the incomplete run itself fail.
ART="${ART_DIR:?}"; mkdir -p "$ART"

# STAMP THE ARTIFACT INVALID FIRST, before anything else can fail.
# Measured, not theorised: the EXIT trap is registered below, so a death BEFORE that line left the
# PREVIOUS run's artifact untouched — and a reader polling `finding5-repair.rc` saw that run's `0`
# and attributed it to this one. Not the zero-cell signature that merely looks like success: a
# STALE SUCCESS, which is worse, because the number is real and belongs to a different run.
# Every report this lane has made reads that file, so the window was live the whole time.
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
echo 97 > "$ART/finding5-repair.rc"
echo "STARTED $RUN_ID — no result yet. rc 97 means the run did not reach its own exit handler." \
  > "$ART/finding5-repair.marker"
# Remaining uncovered window, stated rather than closed: if ART_DIR itself is unset the script
# cannot write anywhere, exits 1, and the artifact keeps whatever it held. A caller must therefore
# read the SCRIPT's rc as well, and check RUN_ID in the marker matches the run it thinks it read.

# EXPECTED CELL COUNT, pinned. An early `exit` (a refusal, a dead planted pid, a failed build guard)
# ends the run with every cell that DID run reporting PASS — and "0 FAIL" reads as a clean run to
# anything grepping for failures. The count is checked from the EXIT trap as well as at the end, so
# an abort cannot skip the check that would have caught the abort.
# This is a count and this lane distrusts counts: it is safe here ONLY because every cell is also
# asserted by name above. It detects a TRUNCATED run, and it is not evidence that anything passed.
EXPECTED_CELLS=32
finish() {
  rc=$?
  ran=$((pass + fail))
  if [ "$ran" -ne "$EXPECTED_CELLS" ]; then
    echo "FAIL SUITE INCOMPLETE — ran $ran of $EXPECTED_CELLS cells (rc=$rc). This is NOT a clean run."
    rc=1
  fi
  echo "$rc" > "$ART/finding5-repair.rc"
  echo "trap $(date -u +%H:%M:%SZ) rc=$rc ran=$ran/$EXPECTED_CELLS run=$RUN_ID" > "$ART/finding5-repair.marker"
  cleanup
  exit "$rc"
}
trap finish EXIT

ck() { if [ "$2" -eq 0 ]; then pass=$((pass+1)); echo "  PASS  $1"; else fail=$((fail+1)); echo "  FAIL  $1"; fi; }

# R0 is asserted HERE, on EVERY capture, not once at the end. The previous version overwrote $ROW in
# each arm and tested `[ -n "$ROW" ]` after the last one, so it proved only that the FINAL capture was
# non-empty while its name claimed "the manager row is never omitted" across all states. That is
# quantifier vacuity — not an empty set, but one state standing in for every state. Found in review.
rows_seen=0
capture() { ROW=$(card); echo "    row| $ROW"
  rows_seen=$((rows_seen+1))
  [ -n "$ROW" ]; ck "R0[$1] the manager row is present in the '$1' state (silence is the failure mode, not a pass)" $?
  # OVER-CAPTURE BOUND. The previous extractor was `grep -A3` and pulled in the card's hint block.
  # For the ABSENCE cells that direction is safe (a stray match reddens), but R2/R3/R7a assert
  # PRESENCE — so neighbouring text matching one of those phrases would be a FALSE PASS. Raised in
  # review as brittleness; it is worse than brittle for three of the cells.
  echo "$ROW" | grep -q 'start the mesh'; [ $? -ne 0 ]
  ck "R10[$1] the capture stops at the row and does not swallow the hint block" $?; }

# HERMETICITY. Captured BEFORE anything overrides HOME, so this is the operator's real home.
# Earned: an earlier version of this harness set COTAL_HOME/XDG_CONFIG_HOME but NOT HOME, and a real
# run wrote `→ wrote cross-vendor skills: /home/david/.agents/skills` — a scratch test mutating the
# operator's actual home. Found in review, then confirmed against my own runs by file mtime.
# Setting HOME is the fix; this witness is the CELL, because an env var is a claim and a witness is
# a measurement.
HOST_HOME="$HOME"
# NEVER `2>/dev/null` IN A CHECK. The first version of this function suppressed stderr, and that is
# the exact defect that nearly hid this finding from me: `find` here is `bfs`, it REJECTED a
# `-newermt '3 hours ago'` argument with rc 1, the redirect swallowed the error, and an empty result
# read as "nothing was modified" — in the check meant to verify a finding against me.
# Suppressing stderr converts "could not check" into "checked and clean", and BOTH reads would
# return the hash of empty input, so the comparison passes VACUOUSLY. The failure must be loud and
# it must not compare equal to a real answer, hence the sentinel plus the explicit cell below.
witness() {
  errf=$(mktemp); out=$(find "$1" -printf '%T@ %s %p\n' 2>"$errf"); rc=$?
  if [ "$rc" -ne 0 ] || [ -s "$errf" ]; then
    printf 'WITNESS-FAILED rc=%s %s' "$rc" "$(tr '\n' ' ' < "$errf" | cut -c1-160)"; rm -f "$errf"; return 0
  fi
  rm -f "$errf"; printf '%s' "$out" | sort | sha256sum | cut -d' ' -f1
}
W_BEFORE=$(witness "$HOST_HOME/.agents")

NODE=/home/david/.nvm/versions/node/v22.23.2/bin/node
REPO=/home/david/Cotal-wt-fm-health
TSX="$REPO/node_modules/tsx/dist/cli.mjs"; CLI="$REPO/bin/cotal.ts"

SCRATCH="${FG5_SCRATCH:?}"
PROJ="$SCRATCH/proj"; HOME_D="$SCRATCH/home"; CFG_D="$SCRATCH/cfg"
# ANCHOR FIRST, before any root-resolving command: an unanchored root walks UP and adopts a shared
# /tmp/.cotal. Measured live on this box; this ordering is the fix, and a grep cannot verify it.
mkdir -p "$PROJ/.cotal" "$HOME_D" "$CFG_D"
PIDFILE="$PROJ/.cotal/manager.pid"

SLEEP_PID=""
cleanup() {
  if [ -n "$SLEEP_PID" ] && kill -0 "$SLEEP_PID" 2>/dev/null; then
    kill -9 "$SLEEP_PID" 2>/dev/null                 # only the pid recorded at creation, exact
    i=0; while kill -0 "$SLEEP_PID" 2>/dev/null && [ $i -lt 25 ]; do sleep 0.2; i=$((i+1)); done
  fi
  [ -n "$SLEEP_PID" ] && echo "  planted pid $SLEEP_PID gone: $(kill -0 "$SLEEP_PID" 2>/dev/null && echo NO || echo yes)"
  echo "  scratch PRESERVED at $SCRATCH"
}

# The whole manager ROW, not its first line. `note()` WRAPS a long row across several box lines, and
# an earlier version of this helper took `head -1` and reported R2/R3 FAIL for text that was present
# on line three. A cell that reads only part of the surface measures only part of the surface.
card() { ( cd "$PROJ" || exit 91
  unset COTAL_SERVERS COTAL_SERVER COTAL_CREDS COTAL_SPACE COTAL_NAME
  HOME="$HOME_D" COTAL_HOME="$HOME_D" XDG_CONFIG_HOME="$CFG_D" COTAL_SKIP_ASSIST=1 \
    timeout 240 "$NODE" "$TSX" "$CLI" setup 2>&1 ) | sed 's/\x1b\[[0-9;]*m//g' \
  | awk '/ manager /{f=1} f{ if ($0 ~ /^│[[:space:]]*│[[:space:]]*$/) exit; print }' \
  | tr '\n' ' ' | sed 's/│//g; s/  */ /g'; }

echo "finding5 scope-1 repair cells  $(date -u +%H:%M:%SZ)"
# SECOND FIRST-ACTION, beside the broker assertion: REFUSE a stale build. This suite drives the CLI
# entry point, which resolves through `dist/` (package `main`), and `dist/` is gitignored. Two runs
# of this very script once reported 10/0 green against a build of a source version already replaced.
# 94 and 95 are read SEPARATELY: 94 is a verdict about the build, 95 means the guard itself could
# not run. Collapsing them would let a broken guard print a confident claim about a build it never
# examined — the same defect, one level up.
"$NODE" "$TSX" "$REPO/bin/smoke/assert-build-current.ts" "$REPO/implementations/cli"
BC=$?
case "$BC" in
  0) ;;
  94) echo "REFUSING TO MEASURE: the build is not current (above). Run pnpm build, then re-run."; exit 94 ;;
  *)  echo "REFUSING TO MEASURE: the build-current guard did not run (rc=$BC). NOT a build verdict."; exit 95 ;;
esac
# onboard once so every later run is a fast repeat that renders the card
( cd "$PROJ"; unset COTAL_SERVERS COTAL_SERVER COTAL_CREDS COTAL_SPACE COTAL_NAME
  HOME="$HOME_D" COTAL_HOME="$HOME_D" XDG_CONFIG_HOME="$CFG_D" COTAL_SKIP_ASSIST=1 \
  timeout 240 "$NODE" "$TSX" "$CLI" setup --yes ) >/dev/null 2>&1

# ---- ALIVE: an unrelated live pid (the defect-B state) ------------------------------------------
setsid sleep 900 & SLEEP_PID=$!
sleep 0.3
echo "$SLEEP_PID" > "$PIDFILE"
echo "planted live non-manager pid $SLEEP_PID"
capture alive
echo "$ROW" | grep -q '✓'; [ $? -ne 0 ]; ck "R4 unrelated-live-pid-never-claimed-running (no ✓ on the manager row)" $?
echo "$ROW" | grep -q "$SLEEP_PID" && echo "$ROW" | grep -q 'manager.pid'; ck "R2 alive-row-names-its-source (pid AND the pidfile path)" $?
echo "$ROW" | grep -q 'serving not checked'; ck "R3 alive-row-says-serving-not-checked" $?
echo "$ROW" | grep -q 'start:'; [ $? -ne 0 ]; ck "R2b alive-row-offers-no-start-hint" $?

# ---- DEAD: same file, pid proven gone -----------------------------------------------------------
kill -9 "$SLEEP_PID" 2>/dev/null
i=0; while kill -0 "$SLEEP_PID" 2>/dev/null && [ $i -lt 25 ]; do sleep 0.2; i=$((i+1)); done
# Three outcomes, not two. `kill -0` failing is not proof of death: EPERM means the process EXISTS
# and is not ours to signal, and folding that into "dead" would run the dead-arm against a live
# process. Only ESRCH proves gone; anything else is a refusal that names its condition.
KERR=$(mktemp)
if kill -0 "$SLEEP_PID" 2>"$KERR"; then
  echo "REFUSING: planted pid $SLEEP_PID is still alive"; rm -f "$KERR"; exit 93
elif ! grep -qi 'no such process' "$KERR"; then
  echo "REFUSING: cannot establish that pid $SLEEP_PID is gone — kill(2) said: $(tr '\n' ' ' < "$KERR")"
  rm -f "$KERR"; exit 93
fi
rm -f "$KERR"
capture dead
echo "$ROW" | grep -q 'not running' && echo "$ROW" | grep -q 'start:'
ck "R5 dead-pid-still-says-not-running-AND-still-offers-the-start-hint (INVERSE CONTROL)" $?

# ---- ABSENT: no pidfile at all ------------------------------------------------------------------
rm -f "$PIDFILE"
capture absent
echo "$ROW" | grep -q 'not running' && echo "$ROW" | grep -q 'start:'
ck "R6 absent-pidfile-still-says-not-running-AND-still-offers-the-start-hint (INVERSE CONTROL)" $?

# ---- UNATTRIBUTABLE: the file holds something that is not a pid ---------------------------------
printf 'not-a-pid-at-all\n' > "$PIDFILE"
capture unattributable
echo "$ROW" | grep -q 'cannot establish'; ck "R7a unattributable-pidfile-says-cannot-establish" $?
echo "$ROW" | grep -q 'start:'; [ $? -ne 0 ]; ck "R7 unattributable-pidfile-offers-NO-start-hint" $?
echo "$ROW" | grep -q '✓'; [ $? -ne 0 ]; ck "R7c unattributable-row-carries-no-green-tick" $?
# INVERSE CONTROL FOR R10: bounding the capture must not truncate it. This row WRAPS — the card
# breaks it as "… · no" / "action recommended" — so a phrase that exists only on the continuation
# line proves the extractor still takes the whole logical row. Without this, R10 could be satisfied
# by an extractor that stopped at the first line and R7a would still pass on line one.
echo "$ROW" | grep -q 'action recommended'
ck "R11 the capture still includes the WRAPPED continuation line (INVERSE CONTROL for R10)" $?

# ---- UNKNOWN: the kernel answers kill(2) with neither success nor ESRCH nor EPERM ---------------
# The fifth state cannot be reached by any pidfile content — `parsePid` rejects anything outside
# 1..0x7fffffff, so an out-of-range pid renders `unattributable`. It needs KERNEL POLICY. The helper
# installs a seccomp filter returning EIO for SYS_kill only and then execs the CLI, so the branch is
# driven the way an LSM or sandbox policy would drive it in production, not by interposition.
# The preregistered matrix claimed all five states; without this arm four were exercised and the
# fifth was asserted by prose. Found in review.
UNKNOWN_BIN="$REPO/.lane/unknown-arm/kill-eio"
if [ ! -x "$UNKNOWN_BIN" ]; then
  ( cd "$REPO/.lane/unknown-arm" && cc -O2 -o kill-eio kill-eio.c ) >/dev/null 2>&1
fi
if [ -x "$UNKNOWN_BIN" ]; then
  # CONTROL FIRST: prove the filter is actually in force in THIS environment. Without it, an
  # `unknown` row could be produced by something else entirely and the arm would credit seccomp.
  KEIO=$("$UNKNOWN_BIN" "$NODE" -e 'try{process.kill(process.pid,0);console.log("NONE")}catch(e){console.log(e.code)}' 2>/dev/null)
  [ "$KEIO" = "EIO" ]; ck "R12-control the seccomp filter makes kill(2) return EIO (got: ${KEIO:-<nothing>})" $?
  KNORM=$("$NODE" -e 'try{process.kill(process.pid,0);console.log("NONE")}catch(e){console.log(e.code)}' 2>/dev/null)
  [ "$KNORM" = "NONE" ]; ck "R12-inverse without the filter kill(2) SUCCEEDS (got: ${KNORM:-<nothing>})" $?

  echo 1 > "$PIDFILE"    # a pid that certainly exists; the filter decides the answer, not the pid
  ROW=$( ( cd "$PROJ" || exit 91
    unset COTAL_SERVERS COTAL_SERVER COTAL_CREDS COTAL_SPACE COTAL_NAME
    HOME="$HOME_D" COTAL_HOME="$HOME_D" XDG_CONFIG_HOME="$CFG_D" COTAL_SKIP_ASSIST=1 \
      timeout 240 "$UNKNOWN_BIN" "$NODE" "$TSX" "$CLI" setup 2>&1 ) | sed 's/\x1b\[[0-9;]*m//g' \
    | awk '/ manager /{f=1} f{ if ($0 ~ /^│[[:space:]]*│[[:space:]]*$/) exit; print }' \
    | tr '\n' ' ' | sed 's/│//g; s/  */ /g' )
  echo "    row| $ROW"
  rows_seen=$((rows_seen+1))
  echo "$ROW" | grep -q 'cannot establish'; ck "R12 unknown-kernel-answer says cannot establish" $?
  echo "$ROW" | grep -q 'neither running nor no-such-process'; ck "R12a unknown names WHICH condition failed (not a bare 'unknown')" $?
  echo "$ROW" | grep -q 'start:'; [ $? -ne 0 ]; ck "R12b unknown offers NO start hint (a start here is the double-launch)" $?
  echo "$ROW" | grep -q '✓'; [ $? -ne 0 ]; ck "R12c unknown carries no green tick" $?
  echo "$ROW" | grep -q 'does not hold a pid'; [ $? -ne 0 ]
  ck "R12d unknown is NOT rendered as unattributable (the two conditions stay distinct)" $?
else
  fail=$((fail+1)); echo "  FAIL  R12 the unknown arm could not be built — NOT a pass, the state is UNMEASURED"
fi

# ---- R13: the row must not read the pidfile a SECOND time ---------------------------------------
# This one is STRUCTURAL and says so. The defect it guards is a race — the record rewritten between
# a display read and the probe's read, so the row names a pid it did not probe — and this suite
# cannot construct that timing reliably. A cell that pretends to catch a race it cannot schedule
# would be worse than one that admits what it checks.
#
# So it asserts the property that makes the race impossible instead: `managerRow` derives pid AND
# state from one call. Written as an absence, so it reddens if a second read is reintroduced.
# A grep is weak evidence and its failure mode is silence, hence the positive control below.
SETUP_TS="$REPO/implementations/cli/src/commands/setup.ts"
ROW_FN=$(awk '/^function managerRow/{f=1} f{print} f&&/^}/{exit}' "$SETUP_TS")
[ -n "$ROW_FN" ]; ck "R13-control managerRow was actually FOUND in setup.ts (an empty extract passes every absence check)" $?
printf '%s' "$ROW_FN" | grep -qE 'readFileSync|MANAGER_PID_PATH'; [ $? -ne 0 ]
ck "R13 managerRow does not read the pidfile itself — pid and state come from ONE call" $?
printf '%s' "$ROW_FN" | grep -q 'managerLivenessSnapshot'
ck "R13a managerRow derives both from managerLivenessSnapshot (the positive half of R13)" $?

# ---- cardinality: every state above actually produced a capture ---------------------------------
# Guards what this refactor could break: if an arm stopped calling `capture`, its R0 cell would simply
# vanish and the suite would still print all-green. The count is checked here BECAUSE each state is
# asserted individually above; on its own a count would be the weak assertion this lane keeps refusing.
[ "$rows_seen" -eq 5 ]; ck "R0-count all 5 rendered states were captured (saw $rows_seen)" $?

# ---- HERMETICITY: the operator's real home was not touched --------------------------------------
# SENSITIVITY CONTROL FIRST. Without it, `witness` returning the same hash twice is equally
# consistent with "nothing changed" and "witness cannot see changes at all" — and over a directory
# that does not exist it would return the hash of empty input in BOTH reads and pass vacuously.
CTRL_BEFORE=$(witness "$HOME_D")
printf 'sensitivity\n' > "$HOME_D/.witness-probe"
CTRL_AFTER=$(witness "$HOME_D")
[ "$CTRL_BEFORE" != "$CTRL_AFTER" ]
ck "R9-control the witness DETECTS a change (else R9 is vacuous, not clean)" $?

W_AFTER=$(witness "$HOST_HOME/.agents")
# Two WITNESS-FAILED sentinels compare EQUAL, so "unchanged" must be established before it is
# believed. This is the 94/95 split in a shell cell: "I checked and it is clean" and "I could not
# check" must never render alike.
case "$W_BEFORE$W_AFTER" in *WITNESS-FAILED*) wok=1 ;; *) wok=0 ;; esac
[ "$wok" -eq 0 ]
ck "R9-usable the witness actually produced a reading both times (not a could-not-check sentinel)" $?
[ "$wok" -eq 0 ] && [ "$W_BEFORE" = "$W_AFTER" ]
ck "R9 hermetic: the operator's real ~/.agents was NOT modified by this run" $?

echo ""
echo "repair cells: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
exit 0
