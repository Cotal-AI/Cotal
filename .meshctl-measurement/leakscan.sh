#!/bin/sh
# Term-leak scanner whose CLEAN verdict cannot be vacuous.
#
# Method (not a wordlist). Three defects this is built to be incapable of:
#   1. terms read as REGEX -> a term that is not a valid regex, or whose regex meaning differs
#      from its literal, is SILENTLY NEVER SCANNED. Fixed with -F, and proven by a MODE CONTROL
#      (metacharacter canary) -- NOT by a per-term self-match, which under -F is a tautology that
#      cannot fail for any input. Driven: 10/10 pathological terms pass it under -F, 4/5 fail
#      under regex, so it had content only in the mode this scanner does not run in.
#   2. comment/blank lines scanned as terms -> junk patterns, and one stray `#` matches everything.
#      Stripped, and every dropped line is checked for being term-shaped before it is discarded.
#   3. a clean verdict indistinguishable from "never looked" -> distinct refusal codes, and the
#      coverage count is printed BESIDE the verdict. A bare "clean" is not an output this emits.
#
# THE COUNT IS A WORK LIST, NEVER A VERDICT. READ EVERY LINE BEFORE YOU ACT ON ONE.
#   This scanner matches LITERAL, CASE-INSENSITIVE, UNANCHORED substrings, and that is deliberate:
#   a false positive is the acceptable failure mode here and a false negative is not. DO NOT "fix"
#   the noise by adding anchors or word boundaries -- that trades the only error you can afford for
#   the one you cannot. Fix it by reading the hits.
#
#   THE WORKED EXAMPLE, and it is the reason this warning exists:
#     pnpm-lock.yaml   THE PRIVATE PROJECT NAME -- the highest-stakes term the list carries --
#                      matched inside a base64 `sha512` integrity hash. On `1aab1389`, i.e. on
#                      main, predating this lane entirely. INNOCENT.
#
#   That hit is indistinguishable from a catastrophic leak until a human opens the file. A reviewer
#   who trusted the count would have "neutralised" a LOCKFILE INTEGRITY HASH and broken the install
#   -- a real, self-inflicted defect committed while remediating a leak that was never there. The
#   damage from acting on a false positive is what makes this a rule rather than a preference.
#
#   Two more of the same shape, lower stakes:
#     implementations/cli/smoke/sys-rotation.smoke.ts   a term inside `genBeforeManifest`
#     pnpm-lock.yaml                                    a term inside another base64 sha512 hash
#
#   Base64 is dense alphanumeric noise; it collides with short terms forever, and no term list
#   avoids that. Expect hits in lockfiles, minified bundles and hashes, and read them.
#
#   AND WHEN YOU WRITE THE FINDING UP: cite the METHOD at full fidelity and ELIDE THE PAYLOAD.
#   `git log -S'<TERM>' <range>` is exactly as reproducible as the literal for anyone holding the
#   list, and reproduces nothing for anyone who is not. A leak record that quotes its own term to
#   prove itself BECOMES the leak -- observed in this lane's own audit, caught before it was pushed.
#
# Exit codes:  0 clean (with coverage)   1 LEAK   93 zero terms parsed   95 terms file unreadable
#              94 a control failed (mode control, or a directional control) -- coverage is not claimable
#              92 the scan ERRORED and did not complete -- there is no verdict
#              96 the term list contains PUBLIC strings, so CLEAN is unreachable and every scan
#                 returns LEAK (needs LEAKSCAN_UPSTREAM_REV; skipped, loudly, when unset)
set -u
TERMS=${1:?usage: leakscan.sh <terms-file> <path...>}
shift
[ -r "$TERMS" ] || { echo "REFUSED(95): terms file unreadable: $TERMS"; exit 95; }

# PROVENANCE, pinned BEFORE first use. Part of the verdict rather than trivia, for two measured
# reasons:
#   - BRE/ERE blindness differs by implementation, so "how blind is this scan" has no answer
#     without naming the engine.
#   - On this box the interactive `grep` is a shell FUNCTION wrapping a different binary with
#     --ignore-files, which SILENTLY SKIPS ignored files on a recursive scan (dist/, .env, local
#     scratch) and still exits 0. Named files are unaffected; a `-r` tree walk is not.
# So the binary is PINNED by absolute path rather than resolved through PATH -- which on this box
# begins with three writable node_modules/.bin directories, any of which could shadow it.
GREP=""
for g in /usr/bin/grep /bin/grep; do [ -x "$g" ] && { GREP=$g; break; }; done
[ -n "$GREP" ] || { echo "REFUSED(95): no grep at a pinned absolute path (/usr/bin/grep, /bin/grep)"; exit 95; }
GREP_IMPL="$GREP -- $("$GREP" --version 2>&1 | head -1)"

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

# Strip comments and blanks -- and prove no dropped line was term-shaped.
sed 's/[[:space:]]*$//' "$TERMS" | "$GREP" -vE '^[[:space:]]*($|#)' > "$WORK/terms"
sed 's/[[:space:]]*$//' "$TERMS" | "$GREP" -E '^[[:space:]]*#' | sed 's/^[[:space:]]*#[[:space:]]*//' \
  | "$GREP" -E '^[A-Za-z0-9][A-Za-z0-9._-]{2,}$' > "$WORK/dropped-but-termshaped" || true
if [ -s "$WORK/dropped-but-termshaped" ]; then
  echo "REFUSED(93): a comment line is term-shaped -- it would be silently unscanned:"
  sed 's/^/    /' "$WORK/dropped-but-termshaped"; exit 93
fi

# NB: `grep -c` prints 0 AND exits 1 on no match, so a `|| echo 0` fallback yields "0\n0" and the
# arithmetic test then ERRORS rather than evaluating -- reaching the right verdict by a broken path.
N=$("$GREP" -c . "$WORK/terms" 2>/dev/null); N=${N:-0}
[ "$N" -gt 0 ] || { echo "REFUSED(93): zero terms parsed from $TERMS"; exit 93; }

# UPSTREAM GUARD (refusal 96) -- A TERM LIST THAT MAKES `CLEAN` UNREACHABLE IS NOT A TERM LIST.
# Measured, and it nearly cost a false report: the list in use had grown to 172 entries, of which
# the ones that fired on a routine two-file scan were all ordinary strings -- `node_modules` and
# friends. Every scan therefore returned LEAK, on any file, forever. That is the exact mirror of the
# tautological self-match this scanner already refuses: there, a guard that could not FAIL; here, a
# verdict that cannot be CLEAN. Both carry zero information, and the second is worse because it
# trains the operator to dismiss the output.
#
# The discriminator is definitional rather than a judgement call: A TERM THAT ALREADY EXISTS IN
# PUBLIC UPSTREAM CONTENT IS NOT A SECRET. Set LEAKSCAN_UPSTREAM_REV to a public rev (e.g.
# origin/main) and any term found there is refused OUT OF THE LIST, by count and never by printing
# it. Unset, the check is skipped and the scan says so -- silence here would be another vacuous pass.
if [ -n "${LEAKSCAN_UPSTREAM_REV:-}" ]; then
  UPHITS=0
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    if git grep -qF -- "$t" "$LEAKSCAN_UPSTREAM_REV" 2>/dev/null; then UPHITS=$((UPHITS+1)); fi
  done < "$WORK/terms"
  if [ "$UPHITS" -gt 0 ]; then
    echo "REFUSED(96): $UPHITS of $N term(s) occur in upstream content at $LEAKSCAN_UPSTREAM_REV."
    echo "             They are public strings, so they are not guarded terms -- and they make a"
    echo "             CLEAN verdict unreachable: every scan of any file returns LEAK on them."
    echo "             Remove them from the list. A scanner that always cries leak is not read."
    exit 96
  fi
  echo "[upstream guard] 0/$N terms occur at $LEAKSCAN_UPSTREAM_REV -- CLEAN is reachable"
else
  echo "[upstream guard] SKIPPED (LEAKSCAN_UPSTREAM_REV unset) -- a generic term in the list would make CLEAN unreachable and this run would not notice"
fi

# MODE CONTROL (metacharacter canary). Replaces a per-term self-match test that was a TAUTOLOGY:
# under -F every string matches itself BY CONSTRUCTION, so that test could not fail for any input.
# Driven: 10/10 pathological terms passed it under -F; 4/5 failed under regex. It had content only
# in the mode this scanner does not run in.
#
# The canary instead exercises the property actually relied on -- that `.` is a LITERAL here.
# `a.c` must NOT match the document `abc`. Under -F it does not; under any regex mode it does.
GREP_MODE=${LEAKSCAN_FORCE_REGEX:-F}   # set LEAKSCAN_FORCE_REGEX=E to prove this control non-vacuous

printf 'abc\n' > "$WORK/canary-doc"
if "$GREP" -q"$GREP_MODE" -- 'a.c' "$WORK/canary-doc" 2>/dev/null; then
  echo "REFUSED(94): MODE CONTROL FAILED -- 'a.c' matched 'abc', so terms are being read as REGEX."
  echo "             Coverage cannot be claimed: a term whose regex meaning differs from its"
  echo "             literal is silently unscanned and the scan would still report clean."
  exit 94
fi

# NEGATIVE CONTROL: a document guaranteed to contain no term must come back clean.
printf 'zzz neutral control document zzz\n' > "$WORK/neg"
if "$GREP" -q"$GREP_MODE"f "$WORK/terms" "$WORK/neg"; then
  echo "REFUSED(94): negative control matched -- the term set matches arbitrary text"; exit 94
fi

# POSITIVE CONTROL: a document built from the terms themselves must come back LEAK.
if ! "$GREP" -q"$GREP_MODE"f "$WORK/terms" "$WORK/terms"; then
  echo "REFUSED(94): positive control did not match -- the scan cannot detect a present term"; exit 94
fi

# THE SCAN. rc is captured, NOT swallowed with `|| true`: grep returns 0=hits, 1=no hits, >=2=ERROR.
# A single invalid-regex term aborts the WHOLE scan, and `|| true` turns that abort into an empty
# HITS and a CLEAN verdict -- zero terms examined, indistinguishable from a real clean. Measured:
# one term `c++core` under -E aborted a 4-term scan entirely. That is refusal 92, never a clean.
HITS=$("$GREP" -rn"$GREP_MODE"f "$WORK/terms" "$@" 2>/dev/null); RC=$?
if [ "$RC" -ge 2 ]; then
  echo "REFUSED(92): the scan ERRORED (grep rc=$RC) -- it did not complete, so there is no verdict."
  echo "             grep: $GREP_IMPL"
  exit 92
fi
if [ -n "$HITS" ]; then
  printf 'LEAK -- coverage %s/%s terms BY CONSTRUCTION (literal mode), mode control held.\n       grep: %s\n' "$N" "$N" "$GREP_IMPL"
  printf '%s\n' "$HITS" | sed 's/^/    /'
  exit 1
fi
printf 'CLEAN -- coverage %s/%s terms BY CONSTRUCTION (literal mode); mode control and both directional controls held.\n        grep: %s\n' "$N" "$N" "$GREP_IMPL"
exit 0
