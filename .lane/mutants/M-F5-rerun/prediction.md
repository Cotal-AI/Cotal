# M-F5 RE-RUN — one run, both mutants, predicted by name before it is run

Pre-registered. Committed BEFORE the runner exists and BEFORE anything is mutated. Git order is the
evidence of preregistration, not this sentence.

## Why a RE-RUN and not a corrected document

`.lane/mutants/M-F5/RESULT.md` reported mutant A as `25/1` while the preserved `mutantA.out` says
`24/2`. The `25/1` came from a FIRST run; the preserved artifact set is from a SECOND. My previous
turn corrected that by annotating the record against the artifacts.

**That was the wrong repair and I am replacing it.** A composite presented as one run is
unfalsifiable — nothing in the record tells a later reader which halves belong together — and a
RESULT.md fixed by reading numbers off an old output is a third artifact agreeing with neither of
the two runs. **One run or no claim.** So: one fresh run produces baseline, mutant A and mutant B
together, and the record reports that run.

The original `M-F5/` artifacts are **NOT overwritten**. They are evidence of what that run did, and
the correction note there stays. This is a new directory.

## The numbers WILL differ from the original, and that is expected

The suite has changed since M-F5: it gained two `COMPARATOR` cells and its operator-home walk was
scoped to `COTAL_WRITE_MARKERS`. `EXPECTED_CELLS` is now **28**, not 26. A re-run reproducing the
old totals would mean the suite had not changed.

## Predicted, by name

**Baseline:** `28 passed, 0 failed`, rc `0`.

**Mutant A — child `HOME` → an external decoy; `COTAL_HOME` untouched.**
- RED, exactly one cell: `HERMETIC: the run's HOME-rooted state landed in the SCRATCH home (.agents, created by the run)` — `.agents` follows `HOME` and lands in the decoy, so `existsSync(join(HOME_D, ".agents"))` is false.
- Predicted total: **27 passed, 1 failed**, rc `1`.
- Predicted GREEN with reasons: the `COTAL_HOME` witness (`onboarded.json` follows `COTAL_HOME`, which this mutant does not move); the `HERMETIC-control` (the scratch home still changes, via `COTAL_HOME`); the precondition cell (evaluated before any run); both `COMPARATOR` cells (an independent probe on a throwaway tree).
- **`HERMETIC: the OPERATOR's real home is byte-for-byte unchanged` is predicted GREEN.** In the original run 2 it went RED and that was never explained. The decoy is not the operator's home, so there is no mechanism by which this mutant should move it.

**Mutant B — the WATCHED path becomes `HOME_D`; `HOME` stays correctly redirected.**
- RED, exactly one cell: `HERMETIC: the OPERATOR's real home is byte-for-byte unchanged across every run above` — the watched path is now a directory that starts empty and provably gains `.agents` and `onboarded.json`, both in `COTAL_WRITE_MARKERS`.
- Predicted total: **27 passed, 1 failed**, rc `1`.
- This mutant never writes outside the scratch.

**Cell-count control:** predicted GREEN on all three, 28 cells executed each time.

## The open question this re-run settles, and the one it does NOT

It settles whether mutant A reddens **one** cell or two under the current suite.

It does **NOT** prove why run 2 saw two. If the operator-home cell is green here, that is
*consistent with* the hypothesis that run 2's second red came from unrelated `~/.claude` churn
(measured today at 18 ambient entries), because the walk is now scoped away from `.claude`. **A
single differing run is consistent-with, not proof-of**, and the record will say exactly that. The
original hypothesis was recorded against a different comparator and does not transfer.

## Discipline

Tree asserted clean before the run. Each mutant's diff must be NON-EMPTY or the runner refuses at
95 — an empty diff means the substitution missed and the "mutant" run measured the unmutated
program, which has already happened once on this experiment. Each restore verified with
`git diff --quiet` **scoped to the mutated file**, so artifact writes cannot mask a failed restore.
rc values read from files written by the runner, never from a pipe.

No broker is started by this suite. This is a suite, not a gate; `smoke:ci` is not run.
