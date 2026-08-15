# M-WD3: replay the collapse against the MUST-DIFFER cells

Pre-registered. Committed BEFORE the run. Baseline: `smoke:shard-status` **32/0 rc=0** at
`016c8bc3`, tree tracked-clean.

## Why replay a mutant that was already killed

M-WD1 killed the collapse against 27 cells. The suite has since gained `MD.1`–`MD.5`, which assert
the three states are distinguishable **from each other** on a machine-readable channel rather than
each against a literal. Those cells are untested: a cell added after the mutant that justified it
has never been shown to be false in the unsafe state. Adding an assertion is not the same as
proving it can fail.

Same mutation as M-WD1, so the comparison is exact:

- **find** (unique): `declined.push(cmd);`
- **replace** (unique the other way): `measured++; /* MUTANT-WD1 collapse */`

## Predicted RED — 14 cells

The 11 from M-WD1: `A2.1 A2.2 A2.3 A2.4 A2.5 A2.6 A2.7 A3.1 A3.2 A3.3 A3.4`.

Plus exactly three of the five new cells:

| cell | why |
| ---- | --- |
| `MD.1` | passed and declined both become rc 0 — the two states stop differing, which is the whole defect |
| `MD.4` | the status set collapses from {0,3,1} to {0,1}, size 2 not 3 |
| `MD.5` | classifying arm 2 from its exit status alone yields `passed`, not `declined` |

## Predicted GREEN — including two of the new cells, stated plainly

| cell | why it cannot see this mutation |
| ---- | ------------------------------- |
| `MD.2` | declined(0) vs failed(1) still differ — a pairwise cell only sees the pair it names |
| `MD.3` | passed(0) vs failed(1) are untouched by the collapse |
| `A2.8`, `A2.9`, `A3.5` | reconciliation still balances at 3 === 3 + 0 |
| `A2.10`, arm 1, arm 4, rig, cell-accounting | unchanged |

`MD.2` and `MD.3` staying green is the honest result and worth stating: **a pairwise must-differ
cell is only a control for the pair it names.** `MD.4` and `MD.5` are the ones that see a collapse
between any two of the three, which is why the set-cardinality and classifier forms are there and
why the three pairwise cells alone would not be sufficient.

## Discipline

Tree asserted clean before the mutant, restore verified with `git diff --quiet`, mutant marker
grepped back to 0.
