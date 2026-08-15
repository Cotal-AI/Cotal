# M-WD1 and M-WD2 — both killed on their predicted cells, and one prediction was WRONG

Preregistered at `ca3ace17` (M-WD1) and `4764a100` (M-WD2). This file is a later commit; git order
is the evidence of preregistration. `date -u` at the time of these runs: **2026-08-15 03:02:01Z**.

Baseline for both: `smoke:shard-status` **27 passed, 0 failed, rc=0**, tree tracked-clean.

## M-WD1 — collapse DECLINED into a pass

`bin/smoke/shard.mjs`: `declined.push(cmd);` → `measured++; /* MUTANT-WD1 collapse */` (1×, unique
in both directions). Run through `scripts/mutation-proof.mjs`: **KILLED**, red and named on
`A2.1 rc is 3 (DECLINED), distinct from both 0 and 1`, 17 marks against a baseline of 27.

### A PREDICTION I GOT WRONG, and it found a real defect in my own cell

I predicted **11** red cells. The first run reddened **10**. The survivor was **A2.4**, which I had
written as `⊘ .*<script>` — that regex matched the **per-member echo**, which the mutant leaves in
place, not the summary list. So the cell was TRUE IN THE UNSAFE STATE: the shard printed `passed`
while A2.4 stayed green. That is decoration, not a control, and it is the exact failure mode this
whole change is about — an assertion that cannot see the thing it names.

Repaired at `579db525` to anchor on the indented summary entry, which only the INCOMPLETE block
emits. Re-run: **11 red, exactly the 11 predicted, A2.4 among them.**

I am recording this rather than quietly correcting the number because a prediction that is edited to
match its result is not a prediction.

### Cells that stayed GREEN under M-WD1, as predicted

`A2.8`, `A2.9`, `A2.10`, `A3.5`, all of arm 1, all of arm 4, and the cell-accounting control.
**`A2.9` and `A3.5` are the reconciliation cells: `3 === 3 + 0` still balances under a collapse.**
Reconciliation alone therefore does NOT detect skip-read-as-pass — which is why M-WD2 exists.

## M-WD2 — lose a member before its cells

`bin/smoke/shard.mjs`: `measured++;` → `/* MUTANT-WD2 lost member */;` (1×, unique both ways).

**13 red cells, exactly the 13 predicted by name**, including `A1.6` and `A2.9` — the reconciliation
cells that M-WD1 could not move. Arm 3 stayed entirely green as predicted, because when every member
declines, `0 + 3 === 3` still reconciles.

### The branch was PROVEN to fire, not assumed

My first check grepped the suite's stdout for `ACCOUNTING FAILURE` and found nothing — but that is
because the runner's text is captured inside the suite's child, not echoed. Rather than let the
inference stand, the branch was driven directly with a trivial pass-only shim:

```
baseline : ✓ smoke:ci shard 0/74 passed (3 of 3 smokes measured)          rc=0
M-WD2    : ✗ shard 0/74 ACCOUNTING FAILURE: declared 3, measured 0, declined 0
                                                       — these do not reconcile.  rc=1
```

rc read from an EXIT-trap artifact, never from a pipe. **Non-equivalence:** different output bytes
and a different exit status.

## Neither mutant is a superset of the other

| cell group | M-WD1 (collapse) | M-WD2 (lost member) |
| ---------- | ---------------- | ------------------- |
| `A1.6` / `A2.9` reconciliation | GREEN | **RED** |
| `A3.1`–`A3.4` all-decline arm | **RED** | GREEN |
| `A2.6` / `A2.7` measured & declined labels | RED | RED |

Each proves a control the other cannot. A control returning the same result as the measurement
would not be a control.

## Restore discipline

Tree asserted clean **before each** mutant, not only at the end. Every restore verified with
`git diff --quiet`, and the mutant marker grepped back to `0` occurrences. A restore that cannot be
verified poisons every measurement after it.

## What is NOT claimed

- **No gate.** `smoke:ci` was not run. `smoke:shard-status` and `smoke:gate-inventory` are suites
  and are named as suites.
- **No real-Windows reachability.** Every arm reaches the declined path through a shim. That the
  suite depends on this code is proven; that a Windows runner reaches it is NOT, and needs a Windows
  runner this box does not have.
- Typecheck is reported separately from suite runs: node strips types, so a green suite does not
  imply a green typecheck. Both were measured (`typecheck` rc=0).
- No live broker was contacted at any point; `shard-status` spawns only a shim.
