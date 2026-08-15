# M-F5 RE-RUN RESULT — ONE run, both mutants, every prediction hit

Preregistered at `3a55f965` (`prediction.md`), which is also the base SHA the runner recorded for
itself. This file is a later commit; git order is the evidence of preregistration.

**Run window, stamped by the runner:** `2026-08-15 03:26:59Z` → `03:29:32Z`.

## Why this run exists

`.lane/mutants/M-F5/RESULT.md` reported mutant A as `25/1` while its preserved `mutantA.out` says
`24/2`: the `25/1` was from a FIRST run, the preserved artifacts from a SECOND. Review
(`fmh-rev-gate`) caught it.

My first repair annotated that record against its artifacts. **That was the wrong repair.** A
composite presented as one run is unfalsifiable — nothing in it tells a later reader which halves
belong together — and a RESULT.md corrected by reading numbers off an old output is a third
artifact agreeing with neither run. **One run or no claim.** So this is one run, and the numbers
below are all from it.

The original `M-F5/` artifacts are untouched. They are evidence of what that run did.

## Result — every predicted cell, by name

| arm | predicted | measured | rc |
| --- | --- | --- | --- |
| **baseline** | `28 passed, 0 failed` | **28 passed, 0 failed** | `0` |
| **A — child `HOME` → external decoy** | 27/1, RED on `HERMETIC: the run's HOME-rooted state landed in the SCRATCH home` | **27 passed, 1 failed — exactly that cell** | `1` |
| **B — watched path → `HOME_D`** | 27/1, RED on `HERMETIC: the OPERATOR's real home is byte-for-byte unchanged` | **27 passed, 1 failed — exactly that cell** | `1` |

Each mutant reddened **one** cell, and it was the predicted one. Both restores verified with
`git diff --quiet` scoped to the mutated file: `restore-clean.rc=0` twice. The cell-count control
did not fire on any arm — 28 cells executed each time, so no arm died before its cells.

## Single-run coherence, checkable rather than asserted

Artifact mtimes are strictly sequential inside the runner's own window
(`baseline.out` → `mutantA.out` → `mutantB.out`, ~50s apart). *Note for a later reader: `ls` prints
these in local time (CEST, UTC+2) while the window stamps are UTC — `05:27:51` local is `03:27:51Z`,
inside the window. That is a timezone difference, not a discrepancy.*

## Non-equivalence, measured

Mutant A's decoy received real generated HOME state — 27 witness lines including
`.agents/skills/team-topology`, the exact path whose descendant writes were invisible to the old
top-level-only comparator:

```
/tmp/mf5r-decoy-fAwuUs/.agents
/tmp/mf5r-decoy-fAwuUs/.agents/skills
/tmp/mf5r-decoy-fAwuUs/.agents/skills/team-topology
```

Mutant B never writes outside the scratch; its non-equivalence is that the watched path becomes one
that provably changes, and the cell that was green becomes red.

## The old run's second red — what this settles and what it does NOT

Under the current suite, **mutant A reddens exactly one cell**, and
`HERMETIC: the OPERATOR's real home is byte-for-byte unchanged` stays **GREEN** — the cell that
went unexplainedly red in the original run 2.

That is **consistent with** the hypothesis that run 2's second red came from unrelated `~/.claude`
churn (measured today at 18 ambient entries from concurrent sessions), since the operator-home walk
is now scoped away from `.claude`.

**It is not proof of it, and I am not recording it as one.** Run 2 used the top-level-only
comparator; this run uses the scoped recursive one. Two things changed between them, so a single
differing run cannot attribute the difference to one of them. The honest statement is: *the defect
does not reproduce under the current suite, and the churn explanation remains a hypothesis.*

## Numbers differ from the original M-F5, by design

The suite gained two `COMPARATOR` cells and had its operator-home walk scoped, so `EXPECTED_CELLS`
is **28**, not 26. A re-run reproducing the old totals would have meant the suite had not changed.

## Not claimed

- **NO GATE.** `smoke:ci` was not run. `ready-card` is a suite and is named as one.
- **No broker.** This suite starts none, and none was running for it.
- Non-equivalence and the kills are established for this run at base `3a55f965`. Nothing here
  claims a verdict about any earlier run other than that its defect does not reproduce now.

## Re-derivation

`bash .lane/mutants/M-F5-rerun/run.sh` from the worktree root at a clean tree. It refuses at 94 if
the target is already dirty and at 95 if either mutant's diff is empty — an empty diff would mean
the substitution missed and the "mutant" run measured the unmutated program, which has happened on
this experiment before.
