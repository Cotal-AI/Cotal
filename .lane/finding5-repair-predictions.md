# Scope 1 — the render-only repair. Cells registered BEFORE the fix is written.

Registered by fm-health at `dffda2b`-era tip `0afeb6ce`, **before any edit to `setup.ts`**.
Approved scope: fm-orchestrator, "the render-only repair, with the cells above as its kill set."

## What scope 1 IS, and what it deliberately is NOT

**IS:** stop the ready card claiming manager health from `kill(pid, 0)`. Preserve the full
five-valued `managerLiveness()` all the way to the render instead of collapsing it through
`managerUp()`.

**IS NOT:** manager health. No affirmative probe is added here — that is scope 2, ruled separate,
because the wedge case is caught only by a round-trip and the pid-reuse case only by identity.
**A repair that quietly created a weaker health claim would be the same defect in a new costume.**

## The constraint that shapes the design

fm-orchestrator, and it is the binding one:

> **A render-only repair must not make the card silent about what it cannot determine.** The failure
> being fixed is a surface asserting more than it measured; the tempting fix is a surface that
> asserts less and still looks confident.

So `alive` does not become silence, and it does not become `○ not running` either — **that would be
a false RED replacing a false green, which this lane has already shipped once (§3.4).**

## The design under test

`managerLiveness()` is five-valued and its own comment says collapsing it to a boolean "is what made
this dangerous". The card will render all five, and **no arm of it may render `✓`** — the green tick
is a health claim and a pidfile cannot support one.

| liveness | marker | claim | start hint? |
| --- | --- | --- | --- |
| `alive` | `·` | local process present (pid N, from `.cotal/manager.pid`) · serving not checked | **no** |
| `dead` | `○` | not running · start: … | **yes — earned** |
| `absent` | `○` | not running · start: … | **yes — earned** |
| `unknown` | `?` | cannot establish: the kernel answered neither running nor no-such-process for pid N | **no** |
| `unattributable` | `?` | cannot establish: `.cotal/manager.pid` does not hold a pid | **no** |

**Source is named in every arm** (the pid and the pidfile), per §2.3. **Age is deliberately NOT
rendered:** the liveness observation is made synchronously at render, so its age is zero by
construction, and stamping the *pidfile's* mtime next to it would present the age of the RECORD as
the age of the OBSERVATION — the exact conflation §2.3 exists to forbid. Recorded so its absence
reads as a decision rather than an omission.

## Kill set — must go RED when the fix is reverted

- **R1 `wedged-manager-never-claimed-running`** — real manager, `State: T`: the card contains no
  `✓ manager` and no `manager  running`.
- **R2 `alive-row-names-its-source`** — the row contains the pid AND `manager.pid`.
- **R3 `alive-row-says-serving-not-checked`** — the row states, in words, the thing it did not check.
- **R4 `unrelated-live-pid-never-claimed-running`** — defect B's planted `sleep` pid: no green row.
- **R7 `unattributable-pidfile-offers-NO-start-hint`** — a pidfile holding non-pid content must not
  recommend starting a manager. *Under the old code this arm reaches `managerUp() === false` and
  DOES print the start hint, so it is a genuine discriminator and not a restatement of R1.*

## Inverse controls — must stay GREEN under the fix, and prove it is SELECTIVE

Registered because "refuse everything" would satisfy the whole kill set above. These are the arms
that fail if the repair over-refuses:

- **R5 `dead-pid-still-says-not-running-AND-still-offers-the-start-hint`** — the earned hint survives.
- **R6 `absent-pidfile-still-says-not-running-AND-still-offers-the-start-hint`** — likewise with no
  pidfile at all.

**If R5/R6 go red, the repair has converted a false green into a surface that can never recommend
anything, which is a worse operator experience and a different defect.**

## Refutation conditions, registered in advance

- If R1 is satisfied by a card that omits the manager row entirely, **R1 is VOID** — silence is the
  failure mode named in the constraint above, not a pass.
- If R5/R6 pass only because the fix left the `dead`/`absent` path untouched **and** R1–R4 were
  satisfied by deleting the row, the set is incoherent; R1's void condition catches it first.
- If any cell's assertion regex would match both the old and new render, it is not a discriminator.
  **Every kill-set cell must be run against the reverted code and observed RED before it counts.**
- A cell asserted on `managerLiveness()`'s return value rather than on rendered card text proves the
  function, not the surface, and does not belong in this set.

## Mutation discipline for this repair

- Checkpoint-commit **before** each mutation. A teardown between "break it" and "put it back" leaves
  the broken half in the tree — measured on another lane tonight.
- **Record whether any survivor is EQUIVALENT.** Survival is the one outcome where a blind cell and
  an absent mutation are indistinguishable, so a survivor must be explained, not re-run.
- Exit codes from EXIT-trap artifacts only.

## Not measured by this repair, stated before it starts

Manager health. `meshStatus`'s hardcoded `DEFAULT_SERVER`. The A5-pin, still carried open from the
re-derivation. §4. Nothing here is a gate.
