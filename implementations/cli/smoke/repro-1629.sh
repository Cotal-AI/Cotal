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
# The suite's own exit status is reported separately: at the defective base it exits 0 while
# spawning the chain, which is exactly why CI never caught this.
set -u
# Repo root, so the suite path below is stable no matter where this is invoked from.
cd "$(dirname "$0")/../../.."
export PATH="$PWD/node_modules/.bin:$PATH"
LOG="$(mktemp -t cotal-1629-reexec-XXXXXX)"
trap 'rm -f "$LOG"' EXIT

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

tsx implementations/cli/smoke/delivery-boot-honesty.smoke.ts
SUITE=$?

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
echo "OK: no self-re-exec observed."
exit 0
