# M-R4 — MEASURED. Predicted exactly, and preserved so it can be audited without me.

Answers reviewer findings **1** (two-read pid/state binding) and **4** (mutation provenance not
independently auditable).

## First, the incoherence the reviewer caught in my previous result file

> *"an uncommitted source mutant cannot simultaneously equal HEAD and leave the tracked tree clean"*

**Correct, and the claim was mine.** A mutation run is at **`HEAD` + a named diff**, never at HEAD
and tracked-clean at once. The earlier wording collapsed "the baseline was clean" and "the mutant ran
at HEAD" into one sentence that cannot be true. Fixed here, and every artifact is preserved rather
than described.

## Preserved artifacts — `.lane/mutants/M-R4/`

| file | what it is |
| --- | --- |
| `base-sha.txt` | `eefab05c8f72664cf716888585c3069b3214ef7e` — the base, recorded before mutating |
| `mutant.diff` | the exact 29-line diff, `git diff` against that base |
| `suite.out` | the mutant run's full output, every cell named |
| `exit-trap.rc` | **`1`** — from the EXIT trap, not a pipe |
| `restore-suite.out` | the post-restore run |
| `restore-exit-trap.rc` | **`0`** |
| `build.log`, `restore-build.log` | the mutant and restore builds (`dist` is what actually runs) |

## The mutation

Reverts `managerRow` to the **two-read** form shipped in `65372e7e`: `MANAGER_PID_PATH()` +
`readFileSync` for the displayed pid, and a separate `managerLiveness()` for the state. **A real
prior state of this file, identified in review — not an invented one.**

## Result: predicted exactly

| | predicted | observed |
| --- | --- | --- |
| RED | `R13`, `R13a` | **`R13`, `R13a`** |
| GREEN | the other 29, all named at `eefab05c` | **all 29 green** |
| rc | 1 | **1** (EXIT-trap) |

**No survivors among the predicted-red. No unpredicted reds.** Baseline before: 31/0 rc 0,
tracked-clean. After restore: **31/0 rc 0**, `git diff --quiet HEAD` clean, HEAD unmoved.

## Why R13 is structural, stated rather than dressed up

The defect is a **race** — the pidfile rewritten between a display read and the probe's read, so the
row names a pid it did not probe. **This suite cannot schedule that timing**, and a cell pretending
to catch a race it cannot construct would be worse than one that says what it checks. So R13 asserts
the property that makes the race impossible: pid and state come from one call.

**R13-control** guards the way this cell fails silently: `awk` extracting nothing would satisfy every
absence check. It asserts the function was actually found.

## Non-equivalence, and the honest reading of the green cells

**M-R4 changes no rendered output in any state this suite can construct** — the two reads only
disagree under a concurrent writer. So the 29 greens are **non-discriminating for this mutation by
construction**, which is why they were named that way in advance rather than after seeing them.

**M-R4 is still NOT equivalent**: it reintroduces a second filesystem read whose result can differ
from the probed one. Registered in advance: had R13/R13a stayed green, the mutation would *still*
have been non-equivalent and the suite simply **BLIND** to it — recorded as a blind cell, not re-run
until it looked right.

## What this does NOT prove

- **Not that the race has been observed.** It has not. The fix removes the window; no cell here
  schedules a writer into it. Stated because "guarded" and "reproduced" are different claims.
- R13 is a **structural/static** cell. It would not catch a *different* second read introduced
  elsewhere in the call path, only one inside `managerRow`.
