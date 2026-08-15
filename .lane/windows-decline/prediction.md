# M-WD: the runner counts a zero-cell exit-0 member as a passed member

Pre-registered BEFORE the run. Written and committed first; the result file is a separate later
commit. Git order is the evidence of preregistration, not this sentence.

## The claim under measurement

`implementations/delivery/smoke/delivery-health-live.smoke.ts:77-82` prints
`DELIVERY-HEALTH LIVE SMOKE — NOT RUN, 0 cells executed.` and calls `process.exit(0)`.
`bin/smoke/shard.mjs:39-43` branches only on `r.status !== 0`. Therefore a member that measured
NOTHING is carried as a passed member and the shard's terminal line reads green.

This is the lane's own defect class: absence of evidence rendered as a pass.

## The rig

`node bin/smoke/shard.mjs 218 221`. Round-robin selection is `i % count === shard`, so with
count=221 and shard=218 the member list is EXACTLY ONE entry: `pnpm smoke:delivery-health-live`
(index 218 of 221, derived by parsing `package.json`, not read off by eye).

`shard.mjs` is UNMODIFIED for this measurement. The platform is what is simulated, not the runner.
A PATH-prepended `pnpm` shim stands in for win32: for the `smoke:delivery-health-live` member it
reproduces that branch's exact output and exit status; every other argv is exec'd through to the
real `pnpm`.

## LIMITATION, declared before the result rather than after it

The shim stands in for a win32 platform this box does not have. This rig proves what `shard.mjs`
does with a zero-cell exit-0 member. It does **NOT** prove the win32 branch is reached on a real
Windows runner, and no claim here says it does. That needs a Windows runner I do not have.

## Predicted outcomes — BY NAME, not by count

### ARM A — the defect (shim exits 0, zero cells measured)

- **A1** shard stdout contains the literal `✓ smoke:ci shard 218/221 passed`
- **A2** shard rc is `0`, read from an EXIT-trap artifact, never from a pipe
- **A3** the member's own output in that same run contains `0 cells executed`
- **A4** the member's own output contains `NOTHING WAS MEASURED`

A1+A2 true while A3+A4 are also true IS the defect: the runner printed a green over a member that
states in its own output that it measured nothing.

### ARM B — inverse control (shim exits 1, byte-identical text otherwise)

- **B1** shard stdout contains `FAILED at: pnpm smoke:delivery-health-live`
- **B2** shard rc is nonzero (expected `1`)
- **B3** shard stdout does NOT contain `passed`

Arm B is not decoration. If B failed, the shim would not be driving the real runner at all and
ARM A's green would be an artifact of a broken rig rather than a property of `shard.mjs`. Arm B is
what makes arm A mean something.

## What a fix must change, stated before the fix exists

Arm A's A1/A2 must become impossible: a declined member must be carried as NOT MEASURED and the
terminal summary must not be expressible as a bare green. Arm B must be UNCHANGED by the fix — a
real failure must still fail. A fix that turns declines into failures would abort the serial
`&&` chain and is the wrong fix; a fix that keeps them green is the defect.
