# Boundary scan — RE-DERIVED, and the refusal is now a verdict

The predecessor's scan REFUSED at rc 95 because no terms file existed on this box, and recorded that
the refusal must not be read as clean. fm-orchestrator supplied the path (path only — never the
contents, and none are reproduced here or anywhere else).

Read at the **absolute path in the PRIMARY checkout**, never a worktree copy:
`/home/david/Cotal/.internal/guidelines/boundary-terms.txt`, scanner
`/home/david/Cotal/.internal/tools/leakscan.mjs`.

## Result

**CLEAN, rc 0. 12/12 terms applied, mode control passing. Terms list canonical, committed `0cdedd9`.**
Corpus: `.lane .changeset bin implementations packages docs .observations package.json` in
`/home/david/Cotal-wt-fm-health` at `564f72d6`.

## The three controls, because a clean from an unproven instrument is worth nothing

| control | question | result |
| --- | --- | --- |
| **mode** (`--selftest`) | is `-F` in effect, i.e. are terms literal not regex? | **14 passed / 0 failed.** Includes the metacharacter canary `a.c` which must NOT match `abc`, plus its mutation arm proving the canary is not inert |
| **corpus reach** (fm-persona's design, stronger than the standing form) | did the scanner actually SEE my files? | a harmless canary appended to a REAL corpus file (`.lane/no-restart-result.md`) was **HIT at `:67`** through the same matchers |
| **inverse** | can it return a real zero? | a token present nowhere → **CLEAN, rc 0** |

**The corpus-reach control is the one that matters and it is why this clean is admissible.** A
control that shares the *command* proves the command runs; a control that shares the *input* proves
the input was seen. The canary was in a file **written during this turn**, so the corpus demonstrably
reaches the newest work, not merely the tree as it stood earlier.

The canary was then removed and its removal **verified through the same matcher** (rc 0), with the
tracked tree confirmed clean afterwards. Only harmless tokens were ever written; **no protected
string was written to any file, including any scratch terms file.**

## An instrument fault of mine, recorded rather than quietly fixed

The first invocation FAILED with `File name too long`, and it was **my harness, not the scanner**:
this shell is zsh, where an unquoted `$VAR` does **not** word-split, so a 197-path list arrived as a
single filename argument. A run that dies this way is loud and harmless — but the same mistake with
a scanner that *tolerated* a bad path list would have produced a zero over nothing. Recorded because
"the instrument errored" and "the instrument found nothing" must never be confused.

## What this clean does NOT mean — the scanner says it and it is repeated here

> *A term absent from the list is a term this scan cannot fail on. A clean means THESE TERMS DO NOT
> APPEAR, never "nothing sensitive appears".*

And `12/12 applied` is **BY CONSTRUCTION, not measured**: under `-F` a term always matches its own
literal, so the count is a property of `-F` rather than evidence about these terms. The numerator is
established; the denominator is not.
