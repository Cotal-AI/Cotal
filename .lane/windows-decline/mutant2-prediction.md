# M-WD2: lose a member before its cells, and prove the reconciliation branch actually bites

Pre-registered. Committed BEFORE the mutant runs. Baseline: `smoke:shard-status` **27/0 rc=0** at
`579db525`, tree tracked-clean.

## Why this mutant exists, given M-WD1 already passed

M-WD1 (the status collapse) left the reconciliation cells **A2.9 and A3.5 green** — I predicted
that and it happened. So M-WD1 proves nothing about whether `declared === measured + declined` is a
real control or merely an identity that always balances. A run that dies before its cells is
indistinguishable from a clean catch by exit code alone; only the count separates them. This mutant
is the one that drives that branch.

**A control that returns the same result as the measurement is not a control** — so the two mutants
must redden *different* cells, and the prediction below says which.

## The mutation

`bin/smoke/shard.mjs`

- **find** (unique, 1 occurrence): `measured++;`
- **replace** (unique in the other direction): `/* MUTANT-WD2 lost member */;`

A member that ran and passed is never counted. `declared` stays 3 while `measured + declined` falls
short, so the ACCOUNTING FAILURE branch must fire.

**Non-equivalence:** arm 1 goes from `passed (3 of 3 smokes measured)` at rc 0 to
`ACCOUNTING FAILURE: declared 3, measured 0, declined 0` at rc 1. Different bytes, different status.

## Predicted RED — 13 cells, BY NAME

**Arm 1** (all pass; nothing counted, so it cannot reconcile): `A1.1` (rc becomes 1), `A1.2` (no
`passed`), `A1.4` (no parseable summary at all), `A1.5`, `A1.6`.

**Arm 2** (one declines; 0 + 1 ≠ 3): `A2.1` (rc becomes 1, not 3), `A2.3`, `A2.4`, `A2.5`, `A2.6`,
`A2.7`, `A2.8`, `A2.9`.

`A1.6` and `A2.9` are the point of this mutant: they are the reconciliation cells that M-WD1 could
not move.

## Predicted GREEN — 14 cells, and the reasons are not flattering to the cells

- `A1.3` — the accounting message says `declined 0` in lowercase; the cell greps uppercase `DECLINED`.
- `A1.7`, `A2.10` — the members are still invoked; only the counting is broken.
- `A2.2` — the accounting-failure text contains no `passed`, so an absent-word cell cannot see this.
- `A3.1`–`A3.5` — **every member declines, so 0 + 3 === 3 still reconciles** and arm 3 is untouched.
- `A4.1`–`A4.4` — the run exits on the failing member before reconciliation is reached.
- rig cell and cell-accounting — 27 cells still execute.

## The two mutants must not redden the same set

| cell | M-WD1 (collapse) | M-WD2 (lost member) |
| ---- | ---------------- | ------------------- |
| A2.9 / A1.6 reconciliation | **GREEN** | **RED** |
| A2.6 / A2.7 measured & declined labels | **RED** | RED |
| A3.1–A3.4 all-decline arm | **RED** | **GREEN** |

Neither mutant is a superset of the other. Each proves a control the other cannot.

## Discipline

Tree asserted clean BEFORE this mutant (not merely at the end of the session), restore verified
with `git diff --quiet`, mutant marker grep must return 0 after restore.
