# MX14 — the first mutation through the private-build seam. PREDICTION, WRITTEN BEFORE THE RUN.

**Stamped `2026-08-15T06:4xZ` (`date -u` at writing), lane tip `4f026d28`. UNRUN.**

**This file exists because a prediction is only a prediction while the outcome is unknown.** Every
other element of the first-run spec — the mutant's location, the shared dist's hash, the seam
confirmation line — is measurable from artifacts at any time afterwards. **The named cell is not.**
Committed before the arm opens so it cannot be written to fit whatever comes back.

## What this run is verifying

**Not anything about core.** It verifies the SEAM: that a mutation proof can compile a deliberately
broken core, grade it, and leave the fleet-linked `packages/core/dist` untouched. The mutation is
chosen to be unambiguous and cheap to reason about, not to teach anything new about connection
control.

This is what closes `FINDING-mutation-on-shared-dist.md`, which is open until it passes.

## The mutation

| | |
| --- | --- |
| file | `packages/core/src/endpoint.ts` |
| line (at `4f026d28`) | **1413** |
| find | `return refusal("not-connected", "this endpoint is already off the mesh - nothing to disconnect");` |
| replace | `return refusal("already-connected", "this endpoint is already off the mesh - nothing to disconnect");` |

**Why this one.** It swaps one NAMED refusal for another. It cannot fail to compile, it cannot
change control flow, and it cannot be confused with a crash — the only observable difference is
*which name comes back*. A suite that asserts "a refusal happened" would stay green; only a suite
asserting **that** refusal can see it. That is precisely the property this lane rewrote its cells to
have, so it is also a re-test of that rewrite.

## PREDICTED CELL — the whole point of this file

**`R1 disconnecting again refuses as [not-connected]`** — in
`extensions/connector-core/smoke/connection-control.smoke.ts`.

**That cell and no other.** Stated as the `--expect-red` argument, so the harness grades `WRONG-RED`
rather than `KILLED` if a different cell dies first.

### What would REFUTE this prediction

- **`SURVIVED`** — the suite passes with the mutant in. R1 would then be asserting that *a* refusal
  occurred rather than *that* refusal, and the cell's name overstates it. **A finding against this
  lane's own cells.**
- **A different cell reddens first** — the mutation reached something I did not predict, so the
  mutant is killed and the mechanism is misunderstood. **`WRONG-RED`, not a pass.**
- **`R3 connecting again refuses as [already-connected]` also reddens** — would mean the two
  refusals are not independently observable, and R1/R3 are one cell wearing two names.
- **An early death with few progress marks** — the run failed for an unrelated reason and grades
  nothing.

## The seam assertions, which are the actual subject

1. **The mutant is in the PRIVATE build**: the scratch's `endpoint.js` contains `already-connected`
   at the mutated site.
2. **`packages/core/dist` is byte-identical before and after the entire proof** — hashed, all 69
   files, not spot-checked.
3. **The seam-confirmation line is present**: the harness refuses unless the suite reported
   `[provenance] core loaded from PRIVATE build`.
4. **The tree is restored**: `git diff --exit-code packages/core/src/endpoint.ts` clean afterwards.

## ⚠ ONE THING THAT MUST BE RESOLVED BEFORE THIS RUNS

**A mutation proof necessarily edits `packages/core/src`, and `packages/core/src` is under an active
freeze.** The seam makes the *build* private; it does not make the *source edit* private, and the
mutant source is in the shared tree for the length of the run.

**That is limit #2 in `LIMITS-private-build.md` arriving in practice on the very first run:** if
anything else runs `tsc` in this worktree during the mutant window, it compiles the mutant into the
fleet-linked dist. The window is short and the harness restores the file, but **the hazard is real
and is not closed by the seam.**

**Raised with fm-orchestrator before the arm opens rather than at run time.** Not to be resolved by
this lane's own reading.
