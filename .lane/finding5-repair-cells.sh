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

ART="${ART_DIR:?}"; mkdir -p "$ART"
trap 'rc=$?; echo "$rc" > "$ART/finding5-repair.rc"; echo "trap $(date -u +%H:%M:%SZ) rc=$rc" > "$ART/finding5-repair.marker"; cleanup' EXIT

pass=0; fail=0
ck() { if [ "$2" -eq 0 ]; then pass=$((pass+1)); echo "  PASS  $1"; else fail=$((fail+1)); echo "  FAIL  $1"; fi; }

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
  COTAL_HOME="$HOME_D" XDG_CONFIG_HOME="$CFG_D" COTAL_SKIP_ASSIST=1 \
    timeout 240 "$NODE" "$TSX" "$CLI" setup 2>&1 ) | sed 's/\x1b\[[0-9;]*m//g' \
  | grep -aA3 " manager " | tr '\n' ' ' | sed 's/│//g; s/  */ /g'; }

echo "finding5 scope-1 repair cells  $(date -u +%H:%M:%SZ)"
# onboard once so every later run is a fast repeat that renders the card
( cd "$PROJ"; unset COTAL_SERVERS COTAL_SERVER COTAL_CREDS COTAL_SPACE COTAL_NAME
  COTAL_HOME="$HOME_D" XDG_CONFIG_HOME="$CFG_D" COTAL_SKIP_ASSIST=1 \
  timeout 240 "$NODE" "$TSX" "$CLI" setup --yes ) >/dev/null 2>&1

# ---- ALIVE: an unrelated live pid (the defect-B state) ------------------------------------------
setsid sleep 900 & SLEEP_PID=$!
sleep 0.3
echo "$SLEEP_PID" > "$PIDFILE"
echo "planted live non-manager pid $SLEEP_PID"
ROW=$(card); echo "    row| $ROW"
echo "$ROW" | grep -q '✓'; [ $? -ne 0 ]; ck "R4 unrelated-live-pid-never-claimed-running (no ✓ on the manager row)" $?
echo "$ROW" | grep -q "$SLEEP_PID" && echo "$ROW" | grep -q 'manager.pid'; ck "R2 alive-row-names-its-source (pid AND the pidfile path)" $?
echo "$ROW" | grep -q 'serving not checked'; ck "R3 alive-row-says-serving-not-checked" $?
echo "$ROW" | grep -q 'start:'; [ $? -ne 0 ]; ck "R2b alive-row-offers-no-start-hint" $?

# ---- DEAD: same file, pid proven gone -----------------------------------------------------------
kill -9 "$SLEEP_PID" 2>/dev/null
i=0; while kill -0 "$SLEEP_PID" 2>/dev/null && [ $i -lt 25 ]; do sleep 0.2; i=$((i+1)); done
kill -0 "$SLEEP_PID" 2>/dev/null && { echo "REFUSING: planted pid still alive"; exit 93; }
ROW=$(card); echo "    row| $ROW"
echo "$ROW" | grep -q 'not running' && echo "$ROW" | grep -q 'start:'
ck "R5 dead-pid-still-says-not-running-AND-still-offers-the-start-hint (INVERSE CONTROL)" $?

# ---- ABSENT: no pidfile at all ------------------------------------------------------------------
rm -f "$PIDFILE"
ROW=$(card); echo "    row| $ROW"
echo "$ROW" | grep -q 'not running' && echo "$ROW" | grep -q 'start:'
ck "R6 absent-pidfile-still-says-not-running-AND-still-offers-the-start-hint (INVERSE CONTROL)" $?

# ---- UNATTRIBUTABLE: the file holds something that is not a pid ---------------------------------
printf 'not-a-pid-at-all\n' > "$PIDFILE"
ROW=$(card); echo "    row| $ROW"
echo "$ROW" | grep -q 'cannot establish'; ck "R7a unattributable-pidfile-says-cannot-establish" $?
echo "$ROW" | grep -q 'start:'; [ $? -ne 0 ]; ck "R7 unattributable-pidfile-offers-NO-start-hint" $?
echo "$ROW" | grep -q '✓'; [ $? -ne 0 ]; ck "R7c unattributable-row-carries-no-green-tick" $?

# ---- the row is never SILENT: every state above rendered a manager row --------------------------
[ -n "$ROW" ]; ck "R0 the manager row is never omitted (silence is the failure mode, not a pass)" $?

echo ""
echo "repair cells: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
exit 0
