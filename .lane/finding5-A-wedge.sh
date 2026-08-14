#!/usr/bin/env bash
# FINDING 5 / DEFECT A (WEDGE) — the incident shape, on a REAL manager.
#
# Defect B proved the card's manager claim is `kill(pid,0)` on whatever integer sits in the pidfile,
# using a `sleep` that was never a manager. This arm proves the same defect on the REAL object: a
# manager that was correctly launched, DID serve, and then stopped serving. That is the incident
# shape — the delivery daemon was a real daemon that had stopped, not a wrong pid.
#
# Every claim about the SURFACE drives the real entry paths (`cotal up`, `cotal ps`, `cotal setup`).
# Nothing calls `managerUp()` directly: a test that builds its own inputs proves the function, not
# the surface.
#
# ---------------------------------------------------------------------------------------------
# WHY THIS RUNS TWO SEPARATE STOP CYCLES — a measured constraint, not a preference.
#
#   MANAGER_LEASE_TTL_MS = 10_000   (packages/core/src/streams.ts:89)
#   `cotal ps` describe deadline    = 10_000ms  (measured: "no describe reply from manager within 10000ms")
#
# They coincide. Proving "the wedged manager does not answer" costs a full 10s of wedge, which is
# exactly the lease TTL — so by the time non-answer is established, the manager has lost its lease
# and shuts itself down on resume. Measured directly, from its own log:
#   "! manager instance 41eq16aj3achbyq5gilyuvgyazilhg2 lost its liveness lease for space "fg5b"
#    (wrong last sequence: 0) - shutting down THIS instance"
# So A3 (needs a LONG stop) and A5 (needs a SHORT stop) CANNOT share one cycle. A single-cycle
# version of this arm does not measure the inverse control — it measures a manager dying of its own
# TTL and reports that as "SIGCONT did not restore it".
# ---------------------------------------------------------------------------------------------
set -u

ART="${ART_DIR:?ART_DIR must be set}"
mkdir -p "$ART"
trap 'rc=$?; echo "$rc" > "$ART/finding5-A.rc"; echo "trap fired $(date -u +%H:%M:%SZ) rc=$rc" > "$ART/finding5-A.marker"; teardown' EXIT

pass=0; fail=0
ck() { if [ "$2" -eq 0 ]; then pass=$((pass+1)); echo "  PASS  $1"; else fail=$((fail+1)); echo "  FAIL  $1"; fi; }
skip() { echo "  NOT MEASURED  $1"; }

NODE=/home/david/.nvm/versions/node/v22.23.2/bin/node
REPO=/home/david/Cotal-wt-fm-health
TSX="$REPO/node_modules/tsx/dist/cli.mjs"
CLI="$REPO/bin/cotal.ts"

# ---- FIRST ACTION: the broker is not the live host ---------------------------------------------
PORT="${FG5_PORT:?}"; SERVER="nats://127.0.0.1:${PORT}"; LIVE="broker.cotal.ai"
case "$SERVER" in *"$LIVE"*) echo "REFUSING: $SERVER names the live host $LIVE"; exit 90;; esac
case "$SERVER" in nats://127.0.0.1:*) :;; *) echo "REFUSING: $SERVER is not loopback"; exit 90;; esac
echo "finding5 arm A — ephemeral broker $SERVER (asserted not $LIVE)   $(date -u +%H:%M:%SZ)"

SCRATCH="${FG5_SCRATCH:?}"
PROJ="$SCRATCH/proj"; HOME_D="$SCRATCH/home"; CFG_D="$SCRATCH/cfg"
mkdir -p "$PROJ/.cotal" "$HOME_D" "$CFG_D" "$SCRATCH/store"
SPACE="fg5$(tr -dc a-z0-9 < /dev/urandom | head -c 6)"

# COTAL_* is DELETED, not overridden: a manager-hosted seat exports COTAL_SERVERS pointing at the
# LIVE broker into every child, and an explicit flag that happens to win today is one refactor from
# not winning.
run_cli() { local cwd="$1"; shift
  ( cd "$cwd" || exit 91
    unset COTAL_SERVERS COTAL_SERVER COTAL_CREDS COTAL_SPACE COTAL_NAME
    COTAL_HOME="$HOME_D" XDG_CONFIG_HOME="$CFG_D" COTAL_SKIP_ASSIST=1 \
      timeout 240 "$NODE" "$TSX" "$CLI" "$@" 2>&1 ); }
strip_ansi() { sed 's/\x1b\[[0-9;]*m//g'; }
# An AFFIRMATIVE round-trip through the real control rails. The refusal arm is textually distinct,
# which is what lets serving and not-serving be told apart rather than inferred from a timeout.
probe() { run_cli "$PROJ" ps | strip_ansi | grep -v '^!' | grep -v '^$' | head -2; }
serving() { probe | grep -q 'no manager reachable'; [ $? -ne 0 ]; }

MGR_PID=""; TORN_DOWN=0
teardown() {
  [ "$TORN_DOWN" -eq 1 ] && return; TORN_DOWN=1
  echo "--- teardown ---"
  # Never leave a STOPPED process behind: a wedged process cannot act on TERM.
  [ -n "$MGR_PID" ] && kill -CONT "$MGR_PID" 2>/dev/null
  run_cli "$PROJ" down 2>&1 | strip_ansi | tail -3
  if [ -n "$MGR_PID" ] && kill -0 "$MGR_PID" 2>/dev/null; then
    kill -TERM "$MGR_PID" 2>/dev/null
    i=0; while kill -0 "$MGR_PID" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.2; i=$((i+1)); done
  fi
  if [ -n "$MGR_PID" ] && kill -0 "$MGR_PID" 2>/dev/null; then
    echo "  REFUSING to delete scratch: recorded pid $MGR_PID STILL ALIVE. PRESERVED at $SCRATCH"
  else
    echo "  recorded manager pid ${MGR_PID:-none} proven gone; scratch PRESERVED as evidence at $SCRATCH"
  fi
}

# ---- launch a REAL mesh --------------------------------------------------------------------
echo "--- launching real mesh in $PROJ (space $SPACE) ---"
run_cli "$PROJ" up --detach --server "$SERVER" --space "$SPACE" --store-dir "$SCRATCH/store" \
  | strip_ansi | grep -E "running in the background|Started nats" | tail -2
PIDFILE="$PROJ/.cotal/manager.pid"
i=0; while [ ! -s "$PIDFILE" ] && [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done
[ -s "$PIDFILE" ] || { echo "REFUSING: no manager pidfile at $PIDFILE"; exit 92; }
MGR_PID=$(cat "$PIDFILE")
echo "recorded manager pid at creation: $MGR_PID (etime $(ps -o etime= -p "$MGR_PID" | tr -d ' '))"

# Onboard BEFORE any stop, so the later card render is a fast repeat run rather than a first run.
run_cli "$PROJ" setup --yes >/dev/null 2>&1

# ---- A1: it must SERVE first, or nothing below proves anything ---------------------------------
i=0; while ! serving && [ $i -lt 12 ]; do sleep 5; i=$((i+1)); done
serving; ck "A1 real-manager-serves-before-wedge (affirmative reply on the real ep rails)" $?
probe | sed 's/^/    probe| /'

# ================= CYCLE 1 — the INVERSE CONTROL, stop kept INSIDE the lease TTL =================
echo "--- cycle 1: 2s stop, inside MANAGER_LEASE_TTL_MS=10000 ---"
kill -STOP "$MGR_PID"; sleep 2; kill -CONT "$MGR_PID"; sleep 8
kill -0 "$MGR_PID" 2>/dev/null; ck "A5a manager SURVIVES a stop inside its lease TTL" $?
serving; ck "A5 sigcont-restores-serving (INVERSE CONTROL: the A3 refusal is wedging, not death)" $?

# ================= CYCLE 2 — the DEFECT. This stop deliberately outlives the TTL. ================
echo "--- cycle 2: the wedge ---"
kill -STOP "$MGR_PID"; sleep 1
kill -0 "$MGR_PID" 2>/dev/null; ALIVE=$?
STATE=$(awk '/^State:/{print $2}' "/proc/$MGR_PID/status" 2>/dev/null)
echo "    /proc/$MGR_PID/status State: ${STATE:-UNREADABLE}   kill -0 rc=$ALIVE"
[ "$ALIVE" -eq 0 ] && [ "$STATE" = "T" ]; ck "A2 wedged-manager-pid-still-alive (kill -0 ok AND State: T)" $?

# A4 FIRST, while the stop is still young: the card render itself proves the pid was alive at render
# time, because a dead pid renders the not-running row (proved by defect B's inverse control).
CARD=$(run_cli "$PROJ" setup | strip_ansi)
echo "$CARD" | grep -aE "manager" | head -2 | sed 's/^/    card| /'
echo "$CARD" | grep -qE '✓ manager +running'; ck "A4 card-renders-manager-running-while-wedged (THE FALSE GREEN)" $?
echo "$CARD" | grep -qE '○ manager +not running'; NG=$?
[ "$NG" -ne 0 ]; ck "A4x green and not-green are mutually exclusive on the SAME captured card" $?

STATE2=$(awk '/^State:/{print $2}' "/proc/$MGR_PID/status" 2>/dev/null)
echo "    State at end of card render: ${STATE2:-UNREADABLE} (still stopped ⇒ the card's green was rendered against a wedged process)"
[ "$STATE2" = "T" ]; ck "A4s process was STILL State: T when the card render finished" $?

serving; SERV=$?
[ "$SERV" -ne 0 ]; ck "A3 wedged-manager-does-not-answer (the same real probe now refuses)" $?
probe | sed 's/^/    probe| /'

skip "A5-pin same-INSTANCE-ID attribution — see the result note: on a single-manager ephemeral broker"
skip "         neither \`cotal ps\` nor \`cotal endpoints\` prints an instance id, so the pin is UNPROVEN."

echo ""
echo "arm A: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
exit 0
