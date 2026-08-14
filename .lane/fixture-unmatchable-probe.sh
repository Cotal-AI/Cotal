#!/usr/bin/env bash
# Does a space-blind supervision matcher see our smoke fixture?
#
# This lives in a SCRIPT FILE on purpose. A first attempt ran the same checks from an inline
# `zsh -c` and reported "MATCHED THE FIXTURE" — because the *checking shell's own argv* contained
# both the guard pattern and the fixture name, so pgrep matched the checker. A positive control
# proves a pattern CAN match something; it does not prove that what it matched was the thing under
# test. Comparison is therefore by PID SET, never by grepping the matched text.
#
# Three arms, and all three must hold for the claim to mean anything:
#   POSITIVE CONTROL  — the guard pattern DOES match the production daemon. If this fails the
#                       pattern is broken and "fixture not matched" would be vacuous.
#   LIVENESS CONTROL  — the fixture IS running and IS findable by its own name. If this fails,
#                       "not matched" only means "not running".
#   THE CLAIM         — no fixture pid appears in the guard pattern's match set.
set -u

GUARD_PATTERN='cotal.ts deliver'      # the space-blind matcher, verbatim
FIXTURE_PATTERN='_fixture-daemon'

self=$$
mapfile -t guard_pids < <(pgrep -f "$GUARD_PATTERN" | grep -v "^$self\$")
mapfile -t fixture_pids < <(pgrep -f "$FIXTURE_PATTERN" | grep -v "^$self\$")

echo "date -u: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "guard pattern '$GUARD_PATTERN' matched ${#guard_pids[@]} pid(s):"
for p in "${guard_pids[@]}"; do [ -n "$p" ] && echo "  $p  $(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-110)"; done
echo
echo "fixture pattern '$FIXTURE_PATTERN' matched ${#fixture_pids[@]} pid(s):"
for p in "${fixture_pids[@]}"; do [ -n "$p" ] && echo "  $p  $(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-110)"; done
echo

# --- POSITIVE CONTROL: the guard pattern must match the production daemon (space main) ---
prod_matched=0
for p in "${guard_pids[@]}"; do
  [ -n "$p" ] || continue
  if tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- '--space main'; then prod_matched=1; fi
done
[ "$prod_matched" -eq 1 ] \
  && echo "POSITIVE CONTROL  PASS  — the guard pattern does match the production daemon (--space main)" \
  || echo "POSITIVE CONTROL  FAIL  — pattern matched no production daemon; the claim below is VACUOUS"

# --- LIVENESS CONTROL: the fixture must actually be running ---
[ "${#fixture_pids[@]}" -gt 0 ] && [ -n "${fixture_pids[0]}" ] \
  && echo "LIVENESS CONTROL  PASS  — the fixture is running and findable by its own name" \
  || echo "LIVENESS CONTROL  FAIL  — no fixture running; 'not matched' would mean nothing"

# --- THE CLAIM: pid-set intersection, which no shell argv can contaminate ---
overlap=""
for f in "${fixture_pids[@]}"; do
  [ -n "$f" ] || continue
  for g in "${guard_pids[@]}"; do [ "$f" = "$g" ] && overlap="$overlap $f"; done
done
if [ -n "$overlap" ]; then
  echo "CLAIM             FAIL  — fixture pids visible to the guard:$overlap"
  exit 1
fi
echo "CLAIM             PASS  — no fixture pid is in the guard pattern's match set"

# What would have refuted this: any fixture pid appearing in guard_pids. Stated before the run.
