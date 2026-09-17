#!/usr/bin/env bash
# Reproduction harness for #1629 — self-contained and runnable as written.
#
# Runs the smoke suite while watching for it re-execing ITSELF as the manager
# (`… delivery-boot-honesty.smoke.ts supervise …`). Each such generation is recorded and killed
# immediately, so the fork chain the issue reports cannot actually grow on a shared host.
#
# Exits NON-ZERO when the defect is present, so it cannot go green in CI while the bug is live:
#   2 = defect present (the suite re-execed itself at least once)
#   0 = no re-exec observed
#   3 = NO RESULT: the run never reached the code under test, so it graded nothing
# The suite's own exit status is reported separately: at the defective base it exits 0 while
# spawning the chain, which is exactly why CI never caught this.
set -u
# Repo root, so the suite path below is stable no matter where this is invoked from.
cd "$(dirname "$0")/../../.."
export PATH="$PWD/node_modules/.bin:$PATH"
LOG="$(mktemp -t cotal-1629-reexec-XXXXXX)"
SUITE_OUT="$(mktemp -t cotal-1629-suite-XXXXXX)"
trap 'rm -f "$LOG" "$SUITE_OUT"' EXIT

watch_reexec() {
  while :; do
    ps -eo pid=,args= | grep -F 'delivery-boot-honesty.smoke.ts supervise' | grep -v grep |
      while read -r pid args; do
        echo "RE-EXEC OF THE SMOKE AS MANAGER: pid=$pid args=$args" >>"$LOG"
        kill -9 "$pid" 2>/dev/null
      done
    sleep 0.3
  done
}
watch_reexec &
WATCHER=$!

# Captured AND streamed: the verdict below has to read the suite's own output to tell "the defect is
# absent" from "the run never got there", and a human watching still wants to see it live.
set -o pipefail
tsx implementations/cli/smoke/delivery-boot-honesty.smoke.ts 2>&1 | tee "$SUITE_OUT"
SUITE=$?
set +o pipefail

sleep 3
kill -9 $WATCHER 2>/dev/null
wait $WATCHER 2>/dev/null

# `grep -c` prints 0 AND exits 1 on no match, so a `|| echo 0` fallback would emit "0\n0" and
# break the integer test below. Count lines that matched instead, which has neither problem.
COUNT=$(grep -c 'RE-EXEC OF THE SMOKE AS MANAGER' "$LOG" 2>/dev/null || true)
[ -n "$COUNT" ] || COUNT=0
echo "smoke exit status: $SUITE"
echo "--- re-exec generations observed ---"
cat "$LOG" 2>/dev/null
echo "--- count: $COUNT ---"
if [ "$COUNT" -gt 0 ]; then
  echo "DEFECT PRESENT: the suite re-execed itself as the manager."
  exit 2
fi

# A ZERO COUNT ONLY MEANS SOMETHING IF THE RUN REACHED THE CODE UNDER TEST.
#
# The re-exec happens inside the `ensureControlPlane` cell. On a loaded host this suite routinely
# dies EARLIER, in fixture setup (a nats TimeoutError out of JetStream/KV creation), and an aborted
# run produces zero generations for the same reason a fixed tree does. Without this gate the harness
# printed "OK: no self-re-exec observed" and exited 0 against a tree with the defect fully present —
# measured, not theorised. That is the same false green the suite itself had, one layer up.
#
# The cell line is the proof the run got that far: the suite prints it whether the cell passes or
# fails, and nothing prints it if the fixture aborted first. No result is NOT a pass.
if ! grep -qE 'ensureControlPlane PROPAGATES|ensureControlPlane threw' "$SUITE_OUT"; then
  echo "NO RESULT: the run never reached the ensureControlPlane cell, so it graded nothing."
  echo "  (on a loaded host this suite aborts in fixture setup; that is not evidence either way)"
  echo "  Re-run when the 1-minute load average is low: $(cut -d' ' -f1 /proc/loadavg) now."
  exit 3
fi
echo "OK: no self-re-exec observed."
exit 0
