#!/usr/bin/env bash
# Boundary scan: does anything in the tracked corpus name work that must not appear in the public
# tree or in mesh traffic?
#
# WHAT THIS INSTRUMENT CLAIMS, PRECISELY:
#
#   Coverage is N/N **BY CONSTRUCTION**, not measured — under `grep -F` every string matches itself,
#   so a per-term self-test is a TAUTOLOGY and cannot fail for any input. An earlier version of this
#   scan reported "6 terms, 6 LIVE, 0 silently unscanned" and that number could not have come out
#   any other way. It was true, and it measured nothing.
#
#   What CAN be established is that the construction holds — that the scanner is actually in literal
#   mode. That is the MODE CONTROL below, and it is the only reason the coverage claim is worth
#   anything. The weaker, true phrasing: **N/N by construction, and here is the control proving the
#   construction holds.**
#
# The per-term self-test is the right instrument for a REGEX scanner, where terms containing
# metacharacters silently never match their own literal. It is the wrong instrument here, and
# prescribing both at once cancels.
#
# Exit codes, distinct on purpose (94 = a verdict, 95/5 = the guard could not run / is mis-built):
#   0  clean — every term scanned in literal mode, no hits
#   94 LEAK — a term was found in the corpus
#   5  REFUSE — the mode control failed: the scanner is not in literal mode, so a clean is worthless
#   95 REFUSE — unreadable terms file, zero terms, or an empty corpus
set -u

TERMS="${1:?usage: leak-scan.sh <terms-file> [--regex-mutant]}"
MUTANT="${2:-}"          # --regex-mutant forces regex mode, to prove the mode control can FAIL
FIXED=(-F)
[ "$MUTANT" = "--regex-mutant" ] && FIXED=()

[ -r "$TERMS" ] || { echo "REFUSE(95): terms file unreadable: $TERMS"; exit 95; }

# Strip comments and blanks. A comment scanned as a term is a term that never matches, which
# inflates a coverage count with entries that were never going to hit anything.
mapfile -t LIST < <(grep -v '^[[:space:]]*#' "$TERMS" | grep -v '^[[:space:]]*$')
[ "${#LIST[@]}" -gt 0 ] || { echo "REFUSE(95): zero terms — a scan over no terms is clean by construction"; exit 95; }

# ---- MODE CONTROL: a metacharacter canary ------------------------------------------------------
# `a.c` must NOT match `abc`. Under -F it does not; under regex it does. This is the property the
# coverage claim rests on, and unlike the self-test it CAN fail.
CTL=$(mktemp); printf 'abc\n' > "$CTL"
if grep -q "${FIXED[@]}" -- 'a.c' "$CTL"; then
  rm -f "$CTL"
  echo "REFUSE(5): mode control FAILED — 'a.c' matched 'abc', so terms are being read as REGEX."
  echo "  A clean verdict in regex mode covers only the terms that happen to be valid regexes"
  echo "  matching their own literal, and cannot be told from 'never looked'."
  exit 5
fi
rm -f "$CTL"

# ---- corpus -------------------------------------------------------------------------------------
shift $(( $# > 0 ? 1 : 0 )); [ "$MUTANT" = "--regex-mutant" ] && shift $(( $# > 0 ? 1 : 0 ))
# The corpus is TRACKED files — what would actually travel if this branch were pushed.
#
# HOW TO DRIVE THE POSITIVE ARM CORRECTLY, because I got this wrong: planting a canary file is not
# enough. An UNTRACKED file is not in `git ls-files`, so the scan never sees it, reports `hits: 0`,
# and that zero reads exactly like a clean corpus. The canary must be added to the index
# (`git add -N`) or the control silently tests nothing:
#     awk 'NR==1{print;exit}' <terms> > .lane/.leak-canary && git add -N .lane/.leak-canary
#     bash .lane/leak-scan.sh <terms>          # must report HIT term[1] and exit 94
#     git rm --cached .lane/.leak-canary; rm -f .lane/.leak-canary
mapfile -t CORPUS < <(git ls-files .lane bin/smoke docs .changeset implementations/cli/src)
[ "${#CORPUS[@]}" -gt 0 ] || { echo "REFUSE(95): empty corpus — a scan over no files is clean by construction"; exit 95; }

# ---- report ------------------------------------------------------------------------------------
# A HIT IS REPORTED BY INDEX AND FILE:LINE, NEVER BY TERM TEXT, AND NEVER WITH THE MATCHING LINE.
# The earlier version echoed the term and the matched line. Pointed at the canonical list that is
# fine only while the terms are ones I chose — against the real list it would print the protected
# string into stdout, into the artifact, and into any report quoting it. **A leak detector whose
# output republishes what it detects is the defect wearing the uniform of the fix.**
# The operator resolves an index against the terms file they already hold; nobody else can.
hits=0
i=0
for t in "${LIST[@]}"; do
  i=$((i+1))
  files=$(grep -rl "${FIXED[@]}" -- "$t" "${CORPUS[@]}" 2>/dev/null | head -5)
  if [ -n "$files" ]; then
    hits=$((hits+1))
    echo "HIT term[$i] in:"; echo "$files" | sed 's/^/    /'
  fi
done

# The verdict may report COVERAGE. It may not report "clean" — see the readme: a clean verdict cannot
# be distinguished from "never looked", which is the whole reason this instrument exists.
echo "terms parsed:      ${#LIST[@]}"
echo "coverage:          ${#LIST[@]}/${#LIST[@]} scannable BY CONSTRUCTION (-F literal mode)"
echo "mode control:      PASS ('a.c' did not match 'abc'); regex-mutant arm refuses at rc 5"
echo "corpus files:      ${#CORPUS[@]}"
echo "hits:              $hits"
[ "$hits" -eq 0 ] || exit 94
exit 0
