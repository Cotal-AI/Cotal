# Finding 5 — cells registered BEFORE the repro is built and BEFORE any fix

Registered by fm-health at `9ad70005`. `date -u` at registration: 2026-08-14T20:0xZ (stamped in the
commit, not here). **Nothing in this file may be edited after the repro runs** — a prediction edited
after its run is not a prediction.

## The claim under test

`cotal setup` renders `✓ manager  running` for a manager that is NOT serving.

Root cause asserted, to be confirmed in source by me and not taken from the dead seat's report:
`setup.ts:348` renders from `mgr = managerUp()` (`setup.ts:339`); `managerUp()` is
`managerLiveness() === "alive"` (`manager-proc.ts:44-46`); `alive` comes from `probe(pid)` i.e.
`kill(pid, 0)`. **That is process existence, which §2.1 names as the thing that is not liveness.**

## The evidence I am NOT inheriting

`fmh-rev-health` reported this reproduced at this same hash and was killed before anything could be
re-derived; its scratch root and broker died with it. **A reproduction whose state is gone is a
hypothesis, not a run.** Every cell below must come out of MY process table, MY broker, MY card.

## TWO DEFECTS. They are kept separate by ruling and must not be collapsed.

**Defect A — WEDGE false green.** A real, correctly-launched manager that has stopped serving.
Caught only by an affirmative round-trip; identity pinning does not catch it.

**Defect B — IDENTITY / PID-REUSE false green.** `manager.pid` fronts a live process that is not a
manager at all. Caught only by identity; an affirmative probe pinned to the wrong instance does not
catch it, and on a box with a live sibling manager an unpinned probe actively hides it.

If my repro can only produce one of these, the other is UNMEASURED and gets said so.

## Named cells — Defect A (wedge)

- **A1 `real-manager-serves-before-wedge`** — a manager I launched answers an affirmative,
  instance-pinned probe. *Registered as the arm that must PASS first; without it the later refusal
  proves nothing, because a manager that never served is a different defect.*
- **A2 `wedged-manager-pid-still-alive`** — after `SIGSTOP`, `kill(pid,0)` still succeeds AND
  `/proc/<pid>/status` reads `State: T (stopped)`. *Two independent sources for one fact, because
  `kill(pid,0)` alone cannot distinguish stopped from running and that is the whole point.*
- **A3 `wedged-manager-does-not-answer`** — the same pinned probe now refuses within its bound.
- **A4 `card-renders-manager-running-while-wedged`** — **THE FALSE GREEN.** The real `cotal setup`
  card, rendered by the real entry path, contains a green manager row. Asserted on the card's own
  output, not on a return value of `managerUp()`.
- **A5 `sigcont-restores-the-same-instance` (INVERSE CONTROL)** — after `SIGCONT`, the pinned probe
  answers again **and reports the same instance id as A1**. *This arm must be able to come out
  differently: if the manager were dead rather than stopped, A5 fails. Without the instance-id
  equality it would also pass if a sibling answered, which is exactly the split-queue trap §3.4
  already measured.*

## Named cells — Defect B (identity / pid reuse)

- **B1 `unrelated-live-pid-in-manager-pid-renders-running`** — a plain sleeping child, never a
  manager, written into `.cotal/manager.pid`; the real card renders the green manager row.
- **B2 `dead-pid-renders-not-running` (INVERSE CONTROL)** — the same file holding a pid I have
  proven dead renders the NOT-running row. *This is what proves B1 is about the pid being alive and
  not about the card being unconditionally green — without it B1 is unfalsifiable.*

## Baseline cell (coverage, measured not assumed)

- **X1 `existing-setup-smoke-passes-every-false-green-above`** — `bin/smoke/setup-pure-live.smoke.ts`
  asserts only that a card EXISTS (`/cotal · status/`) and that nothing launched. Registered as the
  statement of how large the hole is. *This is documentation, NOT an acceptance cell, and must not
  be counted toward any pass total — the previous verdict's `unreachable` cell was exactly this
  mistake: a known coverage gap wearing a checkmark.*

## Refutation conditions — what makes each cell WRONG, registered in advance

- If A4 renders the card from anything other than the real `setup` entry path, **A4 is void** and
  proves only that `managerUp()` returns true, which nobody disputes.
- If A5's probe is not pinned to A1's instance id, **A5 is void on a box with three live managers**.
- If B2 cannot be made to differ from B1, the pair measures nothing.
- If the broker URL is not asserted `!= broker.cotal.ai` as the FIRST action, **the entire run is
  VOID regardless of outcome.**
- If any cell is expressed as a count rather than a name, it is not registered.

## Vacuity traps I have personally been bitten by, checked for in advance

- `.every()` over an empty set passes; use `.some()` or assert non-empty first.
- `?.` optional chaining fails **OPEN** against a claim — `arm?.x !== 0` is true when `arm` is
  absent. Assert the arm EXISTS, then assert about it. *This refuted my own C1 prediction once.*
- A guarded assertion that vanishes is a pass in a skip's costume.
- A regex over card output that matches the NOT-running row's substring would pass both arms; the
  green and not-green assertions must be mutually exclusive by construction, and I must prove that
  by running the same regex against both captured cards.

## What this run will NOT measure, stated before it runs

- No gate. Two named suites at most.
- Nothing about whether a FIX is correct — this run establishes the defect only.
- Nothing about `meshStatus`'s hardcoded `DEFAULT_SERVER` (a separate, already-recorded finding).
- Nothing about the multi-root `readyCard(cwd)`/`managerUp()` asymmetry: the reviewer showed both
  default to `process.cwd()` through the real caller, so it is latent, not currently reachable.
