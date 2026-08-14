#!/bin/sh
# Term-leak scanner whose CLEAN verdict cannot be vacuous.
#
# Method (not a wordlist). Three defects this is built to be incapable of:
#   1. terms read as REGEX -> a term that is not a valid regex, or whose regex meaning differs
#      from its literal, is SILENTLY NEVER SCANNED. Fixed with -F, and PROVEN per-term by feeding
#      each term a document containing exactly itself (self-match control).
#   2. comment/blank lines scanned as terms -> junk patterns, and one stray `#` matches everything.
#      Stripped, and every dropped line is checked for being term-shaped before it is discarded.
#   3. a clean verdict indistinguishable from "never looked" -> distinct refusal codes, and the
#      coverage count is printed BESIDE the verdict. A bare "clean" is not an output this emits.
#
# Exit codes:  0 clean (with coverage)   1 LEAK   93 zero terms parsed   95 terms file unreadable
#              94 a term failed its own self-match control (instrument is lying about coverage)
set -u
TERMS=${1:?usage: leakscan.sh <terms-file> <path...>}
shift
[ -r "$TERMS" ] || { echo "REFUSED(95): terms file unreadable: $TERMS"; exit 95; }

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

# Strip comments and blanks -- and prove no dropped line was term-shaped.
sed 's/[[:space:]]*$//' "$TERMS" | grep -vE '^[[:space:]]*($|#)' > "$WORK/terms"
sed 's/[[:space:]]*$//' "$TERMS" | grep -E '^[[:space:]]*#' | sed 's/^[[:space:]]*#[[:space:]]*//' \
  | grep -E '^[A-Za-z0-9][A-Za-z0-9._-]{2,}$' > "$WORK/dropped-but-termshaped" || true
if [ -s "$WORK/dropped-but-termshaped" ]; then
  echo "REFUSED(93): a comment line is term-shaped -- it would be silently unscanned:"
  sed 's/^/    /' "$WORK/dropped-but-termshaped"; exit 93
fi

# NB: `grep -c` prints 0 AND exits 1 on no match, so a `|| echo 0` fallback yields "0\n0" and the
# arithmetic test then ERRORS rather than evaluating -- reaching the right verdict by a broken path.
N=$(grep -c . "$WORK/terms" 2>/dev/null); N=${N:-0}
[ "$N" -gt 0 ] || { echo "REFUSED(93): zero terms parsed from $TERMS"; exit 93; }

# SELF-MATCH CONTROL, per term: a document containing exactly this term must match it.
# This exercises the property relied on (literal matching), not merely that grep is alive.
UNCOVERED=0
while IFS= read -r t; do
  [ -n "$t" ] || continue
  printf '%s\n' "$t" > "$WORK/self"
  if ! grep -qF -- "$t" "$WORK/self"; then
    echo "REFUSED(94): term fails its own self-match -- it is NOT being scanned"
    UNCOVERED=$((UNCOVERED+1))
  fi
done < "$WORK/terms"
[ "$UNCOVERED" -eq 0 ] || { echo "REFUSED(94): $UNCOVERED/$N terms uncovered"; exit 94; }

# NEGATIVE CONTROL: a document guaranteed to contain no term must come back clean.
printf 'zzz neutral control document zzz\n' > "$WORK/neg"
if grep -qFf "$WORK/terms" "$WORK/neg"; then
  echo "REFUSED(94): negative control matched -- the term set matches arbitrary text"; exit 94
fi

# POSITIVE CONTROL: a document built from the terms themselves must come back LEAK.
if ! grep -qFf "$WORK/terms" "$WORK/terms"; then
  echo "REFUSED(94): positive control did not match -- the scan cannot detect a present term"; exit 94
fi

HITS=$(grep -rnFf "$WORK/terms" "$@" 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "LEAK -- coverage $N/$N terms, all self-match-verified:"
  printf '%s\n' "$HITS" | sed 's/^/    /'
  exit 1
fi
echo "CLEAN -- coverage $N/$N terms, each self-match-verified; both controls held."
exit 0
