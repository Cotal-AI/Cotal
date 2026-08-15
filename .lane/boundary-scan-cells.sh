#!/bin/bash
# Cells for .lane/boundary-scan.sh. Every rc is read from a real invocation's exit status AND
# cross-checked against the SCAN-END marker the script emits. If those two ever disagree, the marker
# is lying and the instrument is void.
cd /home/david/Cotal-wt-fm-health || exit 99
S=.lane/boundary-scan.sh
D="$(mktemp -d)"; trap 'rm -rf "$D"' EXIT
PASS=0; FAIL=0

# Terms OUTSIDE the repo. Placeholders: the real boundary term is never written to disk by me.
printf 'ZZQX-SENTINEL-ALPHA\nZZQX-SENTINEL-BETA\n' > "$D/terms-clean.txt"
printf 'delivery\n'                                 > "$D/terms-hit.txt"   # certainly in the diff
printf 'ZZQX-SENTINEL-ALPHA\n\nZZQX-B\n'            > "$D/terms-blank.txt"

cell() { # cell <name> <expected-rc> <expected-verdict> <required-reason-fragment> <terms> <ref>
  # The reason fragment is NOT decoration. Four of the cells below expect rc=9/REFUSED, and without
  # asserting WHICH refusal, a single bug that made every input refuse for one wrong reason would
  # pass all four. Every refusal is asserted as THAT refusal or it is not asserted at all.
  local name="$1" want_rc="$2" want_v="$3" want_msg="$4" terms="$5" ref="$6"
  bash "$S" "$terms" "$ref" > "$D/out.txt" 2>&1
  local got_rc=$?
  local marker; marker="$(grep -c '^SCAN-END' "$D/out.txt")"
  local got_v; got_v="$(sed -n 's/^SCAN-END rc=[0-9]* verdict=//p' "$D/out.txt")"
  local marker_rc; marker_rc="$(sed -n 's/^SCAN-END rc=\([0-9]*\).*/\1/p' "$D/out.txt")"
  grep -q -F "$want_msg" "$D/out.txt"; local msg_rc=$?
  if [ "$got_rc" = "$want_rc" ] && [ "$got_v" = "$want_v" ] && [ "$marker" = "1" ] \
     && [ "$marker_rc" = "$got_rc" ] && [ "$msg_rc" -eq 0 ]; then
    echo "PASS $name  rc=$got_rc verdict=$got_v  reason:\"$want_msg\""; PASS=$((PASS+1))
  else
    echo "FAIL $name  want rc=$want_rc verdict=$want_v msg=\"$want_msg\" | got rc=$got_rc verdict='$got_v' markers=$marker marker_rc='$marker_rc' msg_rc=$msg_rc"
    sed -n '1,6p' "$D/out.txt"; FAIL=$((FAIL+1))
  fi
}

# CROSS-CELL DISCRIMINATION: the four refusals must not merely all be rc=9, they must say four
# DIFFERENT things. Collected as we go and checked for uniqueness at the end. No pipe here either —
# not because an exit code is read from it, but because this file should not model the construct.
: > "$D/reasons.txt"
collect_reason() { bash "$S" "$1" "$2" > "$D/r.txt" 2>&1; grep '^REFUSING:' "$D/r.txt" >> "$D/reasons.txt"; }

echo "== C1 clean corpus, terms absent -> CLEAN (and the per-term control must have RUN)"
cell C1-clean 0 CLEAN "positive control: PASSED for all 2 terms" "$D/terms-clean.txt" origin/main

echo "== C2 NEGATIVE CONTROL OF THE SCRIPT: a term that IS present -> LEAK"
echo "   (without this cell, C1's CLEAN is indistinguishable from an instrument that never matches)"
cell C2-leak 1 LEAK "LEAK: a boundary term appears in the pushed CONTENT" "$D/terms-hit.txt" origin/main

echo "== C3-C6 refusals, each asserted as ITS OWN refusal, not merely as rc=9"
cell C3-blank    9 REFUSED "contains a blank line"                "$D/terms-blank.txt" origin/main
cell C4-badref   9 REFUSED "no such ref: no/such/ref"             "$D/terms-clean.txt" no/such/ref
cell C5-noterms  9 REFUSED "terms file unreadable"                "$D/does-not-exist"  origin/main
cp "$D/terms-clean.txt" .lane/terms-INSIDE-tree.txt
cell C6-inside   9 REFUSED "is INSIDE the repository"             .lane/terms-INSIDE-tree.txt origin/main
collect_reason "$D/terms-blank.txt" origin/main
collect_reason "$D/terms-clean.txt" no/such/ref
collect_reason "$D/does-not-exist"  origin/main
collect_reason .lane/terms-INSIDE-tree.txt origin/main
rm -f .lane/terms-INSIDE-tree.txt

echo "== C6b the four refusals must be four DISTINCT messages"
n_reasons="$(grep -c . "$D/reasons.txt")"
n_uniq="$(sort -u "$D/reasons.txt" > "$D/reasons-u.txt"; grep -c . "$D/reasons-u.txt")"
if [ "$n_reasons" = "4" ] && [ "$n_uniq" = "4" ]; then
  echo "PASS C6b-distinct  4 refusals, 4 distinct messages (no shared catch-all)"; PASS=$((PASS+1))
else
  echo "FAIL C6b-distinct  reasons=$n_reasons unique=$n_uniq"; cat "$D/reasons.txt"; FAIL=$((FAIL+1))
fi

echo "== C7 DEATH PATH: fault-injected mid-run signal must still emit a marker"
sed 's|^# ---- POSITIVE CONTROL|kill -TERM $$\n# ---- POSITIVE CONTROL|' "$S" > "$D/dying-scan.sh"
bash "$D/dying-scan.sh" "$D/terms-clean.txt" origin/main > "$D/out7.txt" 2>&1
rc7=$?
v7="$(sed -n 's/^SCAN-END rc=[0-9]* verdict=//p' "$D/out7.txt")"
if [ "$v7" = "KILLED-BY-SIGNAL" ]; then
  echo "PASS C7-signal  rc=$rc7 verdict=$v7 (a scan that dies names itself)"; PASS=$((PASS+1))
else
  echo "FAIL C7-signal  rc=$rc7 verdict='$v7'"; FAIL=$((FAIL+1))
fi

echo "== C8 INVERSE OF C7: SIGKILL cannot be trapped, so NO marker appears at all."
echo "   That is the distinguishable state — the reader sees no SCAN-END and must not read it as clean."
sed 's|^# ---- POSITIVE CONTROL|kill -KILL $$\n# ---- POSITIVE CONTROL|' "$S" > "$D/killed-scan.sh"
bash "$D/killed-scan.sh" "$D/terms-clean.txt" origin/main > "$D/out8.txt" 2>&1
rc8=$?
m8="$(grep -c '^SCAN-END' "$D/out8.txt")"
if [ "$m8" = "0" ]; then
  echo "PASS C8-nomarker  rc=$rc8 markers=$m8 (absence of the marker is the death signal)"; PASS=$((PASS+1))
else
  echo "FAIL C8-nomarker  rc=$rc8 markers=$m8"; FAIL=$((FAIL+1))
fi

echo
echo "CELLS: pass=$PASS fail=$FAIL"
echo "$FAIL" > "$D/scan-cells.fail"
exit 0
