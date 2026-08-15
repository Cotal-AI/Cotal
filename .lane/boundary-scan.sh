#!/bin/bash
# Pre-push boundary scan that CANNOT report a clean it did not earn.
#
# WHY THIS IS A FILE AND NOT A REMEMBERED COMMAND. Two seats on this box wrote `grep … | head` and
# read `$?` on the same night, ten minutes apart — the second while VERIFYING the first one's
# instance of it. A pipeline's exit status is the last command's, so `head` succeeded whether or not
# grep matched. Both readings were worthless. Both happened to fail LOUD (a false leak), which is the
# only reason neither shipped a false clean.
#
# Neither of us caught it by remembering the rule. A rule two people can state and still walk into
# within the hour is a rule about attention, and attention is what runs out. So the construct is made
# IMPOSSIBLE rather than discouraged:
#
#   1. NO PIPE BETWEEN A PREDICATE AND ITS EXIT CODE. `grep -q` is invoked directly; `$?` is its own.
#   2. THE POSITIVE CONTROL RUNS IN THIS INVOCATION, not as a step someone can skip — and it runs
#      PER TERM, because `grep -q` stops at the first match, so seeding all terms at once and getting
#      rc 0 proves exactly one pattern reaches and says nothing about the rest.
#   3. A TERMINAL MARKER ON EVERY EXIT PATH, emitted from an EXIT trap that also catches signals. A
#      scan that dies halfway prints `verdict=DIED-BEFORE-VERDICT`. This is the whole point: absence
#      of output must not be readable as absence of findings. That confusion is this lane's entire
#      subject matter, and an instrument that reproduces it is not one I get to keep.
#   4. IT FAILS CLOSED. Every unexpected state exits 9. A guard whose broken state looks like its
#      passing state is not a guard.
#
# Usage:  .lane/boundary-scan.sh <terms-file> <base-ref>
# Exit:   0 = CLEAN     1 = LEAK FOUND     9 = REFUSED (instrument unproven or input rejected)
# Read the verdict from the SCAN-END line, never from the absence of complaints.
set -u   # NOT `set -e`: the `grep -q …; RC=$?` idiom below is a deliberate non-zero, and -e would
         # turn every clean scan into a silent early exit — the exact class of bug this file exists
         # to prevent, arriving through the flag meant to prevent it.

VERDICT="DIED-BEFORE-VERDICT"
WORK=""
# `RC=$?` MUST be the first statement in the trap. An earlier draft of this file cleaned up first and
# then read `$?`, which reports the exit code of `rm` instead of the exit code of the scan — the
# reported result silently detached from the measured one, inside the instrument built to stop that.
# Kept as a comment because the next person to add a cleanup line will be tempted to put it first.
cleanup() {
  RC=$?
  [ -n "$WORK" ] && rm -rf "$WORK"
  echo "SCAN-END rc=${RC} verdict=${VERDICT}"
}
trap cleanup EXIT
trap 'VERDICT="KILLED-BY-SIGNAL"; exit 9' INT TERM HUP

refuse() { VERDICT="REFUSED"; echo "REFUSING: $*"; exit 9; }

TERMS="${1:-}"
REF="${2:-}"
[ -n "$TERMS" ] && [ -r "$TERMS" ] || refuse "terms file unreadable: '$TERMS'"
[ -n "$REF" ] || refuse "no base ref given"
git rev-parse --verify "$REF" >/dev/null 2>&1 || refuse "no such ref: $REF"

# THE TERMS FILE MUST LIVE OUTSIDE THE REPO. It contains the boundary terms verbatim, so a terms file
# inside the working tree is itself the leak this scan exists to prevent — and it would be a leak the
# scan cannot see, because a file that matches every term makes its own presence look like a finding.
TOP="$(git rev-parse --show-toplevel)" || refuse "not inside a git repository"
TERMS_ABS="$(cd "$(dirname "$TERMS")" && pwd)/$(basename "$TERMS")" || refuse "cannot resolve terms path"
case "$TERMS_ABS" in
  "$TOP"/*) refuse "the terms file is INSIDE the repository ($TERMS_ABS). It names the boundary terms verbatim; keep it outside the tree." ;;
esac

# A blank or whitespace-only line in a `grep -F -f` pattern file matches EVERY line, which would make
# both the control and the scan pass on any input at all. Refuse rather than scan with it.
if grep -q -E '^[[:space:]]*$' "$TERMS"; then
  refuse "the terms file contains a blank line — as a -F pattern that matches everything, making this instrument meaningless"
fi
TERM_COUNT=$(grep -c . "$TERMS")
[ "$TERM_COUNT" -gt 0 ] || refuse "the terms file has no terms in it"

WORK="$(mktemp -d)" || refuse "could not create a work dir"

git diff "$REF"..HEAD > "$WORK/diff.txt" || refuse "could not produce the diff"
git log "$REF"..HEAD --format="%B" > "$WORK/msgs.txt" || refuse "could not read the commit messages"
git rev-parse --abbrev-ref HEAD > "$WORK/branch.txt" || refuse "could not read the branch name"
COMMITS="$(git rev-list --count "$REF"..HEAD)"
FILES="$(git diff --name-only "$REF"..HEAD > "$WORK/files.txt"; grep -c . "$WORK/files.txt")"

# An empty corpus is not a clean corpus. Reporting CLEAN over nothing is the vacuous pass.
if [ ! -s "$WORK/diff.txt" ] && [ ! -s "$WORK/msgs.txt" ]; then
  refuse "nothing to scan (empty diff AND empty messages) — a clean over an empty set proves nothing"
fi

# ---- THE SCANS. Each rc is grep's own. No pipe, no `&&` chain deciding a verdict.
grep -q -i -F -f "$TERMS" "$WORK/diff.txt";   RC_DIFF=$?
grep -q -i -F -f "$TERMS" "$WORK/msgs.txt";   RC_MSGS=$?
grep -q -i -F -f "$TERMS" "$WORK/branch.txt"; RC_BRANCH=$?
grep -q -i -E "co-authored-by|generated with claude|claude code|🤖" "$WORK/msgs.txt"; RC_ATTR=$?

# rc 0 = matched, rc 1 = no match. ANYTHING ELSE is an instrument failure and is not a clean.
for pair in "content:$RC_DIFF" "messages:$RC_MSGS" "branch:$RC_BRANCH" "attribution:$RC_ATTR"; do
  rc="${pair##*:}"
  [ "$rc" -le 1 ] || refuse "the ${pair%%:*} scan errored (rc=$rc) — that is not a clean"
done

# ---- POSITIVE CONTROL, PER TERM, same corpus and same method as the scans above.
# Each term is seeded into a copy of the real diff and must be caught by the full pattern set. If any
# single term cannot be found when it is definitely present, this instrument is blind to that term and
# a clean from it would only be evidence about grep.
CONTROL_FAILED=0
while IFS= read -r term; do
  [ -n "$term" ] || continue
  cp "$WORK/diff.txt" "$WORK/poisoned.txt"
  printf '%s\n' "$term" >> "$WORK/poisoned.txt"
  grep -q -i -F -f "$TERMS" "$WORK/poisoned.txt"
  if [ $? -ne 0 ]; then
    echo "CONTROL FAILED: a seeded term was NOT caught by the pattern set"
    CONTROL_FAILED=1
  fi
done < "$TERMS"
[ "$CONTROL_FAILED" -eq 0 ] || refuse "the positive control failed — this instrument is blind to at least one term"
echo "positive control: PASSED for all ${TERM_COUNT} terms (each seeded into the real corpus and caught)"
echo "scanned: ${COMMITS} commits, ${FILES} files, against ${REF}"

LEAK=0
[ "$RC_DIFF"   -eq 0 ] && { echo "LEAK: a boundary term appears in the pushed CONTENT";  LEAK=1; }
[ "$RC_MSGS"   -eq 0 ] && { echo "LEAK: a boundary term appears in a COMMIT MESSAGE";    LEAK=1; }
[ "$RC_BRANCH" -eq 0 ] && { echo "LEAK: a boundary term appears in the BRANCH NAME";     LEAK=1; }
[ "$RC_ATTR"   -eq 0 ] && { echo "LEAK: an AI-attribution trailer appears in a message"; LEAK=1; }

if [ "$LEAK" -ne 0 ]; then VERDICT="LEAK"; exit 1; fi
VERDICT="CLEAN"
exit 0
