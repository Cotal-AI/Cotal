# M-WD1: collapse DECLINED back into a pass, and name every cell before running

Pre-registered. Committed BEFORE the mutant runs; git order is the evidence, not this sentence.
Baseline to beat: `smoke:shard-status` is **27/0 rc=0** at `0d42dba7`, tree tracked-clean.

## The mutation

`bin/smoke/shard.mjs`

- **find** (unique): `declined.push(cmd);`
- **replace** (unique in the other direction): `measured++; /* MUTANT-WD1 collapse */`

A declined member is then counted as a measured one. This is precisely the collapse the third
status exists to prevent, and it restores the pre-fix semantics: "declined" and "measured and fine"
become the same value again.

**Non-equivalence:** the mutant changes observable output, not just internals — arm 2 goes from
`INCOMPLETE — 2 of 3 measured, 1 DECLINED` at rc 3 to `passed (3 of 3 smokes measured)` at rc 0.
Different bytes, different exit status.

## Predicted RED — 11 cells, BY NAME

| cell | why it must go red under the collapse |
| ---- | ------------------------------------- |
| A2.1 | rc becomes 0, not 3 |
| A2.2 | the word `passed` reappears |
| A2.3 | no `INCOMPLETE` summary is printed |
| A2.4 | the declining member is no longer named |
| A2.5 | `This is NOT a pass` is no longer printed |
| A2.6 | measured becomes 3, not 2 |
| A2.7 | declined becomes 0, not 1 |
| A3.1 | rc becomes 0, not 3 |
| A3.2 | the word `passed` reappears |
| A3.3 | measured becomes 3, not 0 |
| A3.4 | declined becomes 0, not 3 |

Primary named assertion for `--expect-red`:
`A2.1 rc is 3 (DECLINED), distinct from both 0 and 1`.

## Predicted GREEN — stated because a cell that cannot see this mutation is not a control for it

| cell | why it stays green, honestly |
| ---- | ---------------------------- |
| A2.8 | declared is still 3 — the mutation does not lose a member |
| **A2.9** | **RECONCILES: 3 === 3 + 0 still balances.** Reconciliation alone does NOT detect this collapse |
| **A3.5** | same — reconciliation is a control for a LOST member, not for a mislabelled one |
| A2.10 | all 3 members are still invoked |
| A1.1–A1.7 | arm 1 has no declining member, so the mutated branch is never taken |
| A4.1–A4.4 | the failure path is untouched |
| cell accounting | 27 cells still execute |

**This is the point worth being explicit about:** the reconciliation cells are green under this
mutant. If the suite's only claim were "the counts reconcile", it would pass while skip read as
pass. Reconciliation catches a member lost before its cells; the declined/measured cells catch a
member mislabelled as fine. **They are two different controls and neither substitutes for the
other** — which is exactly why both are asserted.

## Discipline for the run

Tree asserted clean BEFORE the mutant and verified with `git diff --quiet` after the restore, not
only at the end. A restore that cannot be verified poisons every measurement after it.

## What a red here does NOT prove

That the mutant is killed shows the suite DEPENDS on that branch of `shard.mjs`. It does not by
itself show a real entry point reaches it on Windows — the suite builds its members through a shim.
Real-Windows reachability is NOT claimed anywhere in this lane.
