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
mapfile -t CORPUS < <(git ls-files .lane bin/smoke docs .changeset implementations/cli/src)
[ "${#CORPUS[@]}" -gt 0 ] || { echo "REFUSE(95): empty corpus — a scan over no files is clean by construction"; exit 95; }

hits=0
for t in "${LIST[@]}"; do
  out=$(grep -rn "${FIXED[@]}" -- "$t" "${CORPUS[@]}" 2>/dev/null | head -3)
  if [ -n "$out" ]; then hits=$((hits+1)); echo "LEAK: $t"; echo "$out" | sed 's/^/    /'; fi
done

echo "terms: ${#LIST[@]} (coverage N/N BY CONSTRUCTION under -F; the mode control above is what makes that meaningful)"
echo "corpus files: ${#CORPUS[@]}"
echo "hits: $hits"
[ "$hits" -eq 0 ] || exit 94
exit 0
