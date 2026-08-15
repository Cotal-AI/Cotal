# M-WD RESULT — REPRODUCED. The runner prints green over a member that measured nothing.

Preregistered at `c00a3860` (`.lane/windows-decline/prediction.md`); this file is a later commit.
Git order establishes preregistration, not this sentence.

Measured `date -u` at turn start: **2026-08-15 02:51:11Z**. Node `v22.23.2`
(`~/.nvm/versions/node/v22.23.2/bin`), never bare `node`.

## Result: all 7 preregistered cells hit, by name

| cell | assertion | outcome |
| ---- | --------- | ------- |
| A1 | shard stdout contains `✓ smoke:ci shard 218/221 passed` | ✓ |
| A2 | shard rc `0`, read from an EXIT-trap artifact | ✓ (`armA.rc` = `0`) |
| A3 | member output contains `0 cells executed` | ✓ |
| A4 | member output contains `NOTHING WAS MEASURED` | ✓ |
| B1 | shard stdout contains `FAILED at: pnpm smoke:delivery-health-live` | ✓ |
| B2 | shard rc nonzero | ✓ (`armB.rc` = `1`) |
| B3 | arm B stdout contains no `passed` | ✓ |

Cells were asserted mechanically (`grep -qF` / artifact read), not read off by eye.

## The defect, as two lines of one preserved run

From `out/armA.out`, two lines apart:

```
 9:  NOTHING WAS MEASURED. Do not read this as a pass — read it as absence of evidence.
11:✓ smoke:ci shard 218/221 passed (1 smokes)
```

The member states in its own output that it measured nothing. The runner, two lines later, calls
that a pass and exits 0. `bin/smoke/shard.mjs:39-43` branches only on `r.status !== 0`, so
"declined" and "measured and fine" are the same value to it.

This is the lane's own defect class, committed by the lane: absence of evidence rendered as
success. It is the same shape as the incident — messages accepted, senders told they were sent,
zero log entries.

## Why arm B is not decoration

Arm B is byte-identical except for the shim's exit status. It proves the shim really drives the
real `shard.mjs` and that the runner CAN distinguish outcomes. Without it, arm A's green would be
consistent with a rig that never invoked the runner at all. Arm A means something only because
arm B failed as predicted.

## Non-equivalence

The two arms differ ONLY in the member's exit status; the printed text is identical. So the green
is caused by the exit status, not by the text. A runner that read the output would not be fooled;
this one reads only the status.

## LIMITATIONS — what this run does NOT establish

- **It does not prove the win32 branch is reached on a real Windows runner.** The shim stands in
  for a platform this box does not have. That claim needs a Windows runner and is NOT made.
- `shard.mjs` and `delivery-health-live.smoke.ts` were **unmodified** for this measurement
  (`git status --short` on both was empty at run time). The platform was simulated; the runner
  was not.
- One member was exercised (index 218 of 221). This is not a gate, was not run as one, and no
  statement here is a gate claim. The other 220 members were NOT run.
- No live broker. No `smoke:ci`. No Scope 2 claim.

## Re-derivation

At `c00a3860` + this rig: `node bin/smoke/shard.mjs 218 221` with `.lane/windows-decline/shim`
prepended to `PATH`, `SHIM_RC=0` (arm A) and `SHIM_RC=1` (arm B). Round-robin `i % 221 === 218`
selects exactly one member. Both raw outputs and both rc artifacts are committed beside this file.
