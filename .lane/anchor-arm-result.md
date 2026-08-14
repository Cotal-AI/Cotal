# The TMPDIR anchor arm — MEASURED. Every registered cell matched.

Predictions registered at **`3624e1a6`, before the run**. Suite `bin/smoke/setup-pure-live.smoke.ts`
run **UNMODIFIED**. Lane tip `8ae0d438`. `dist` proven current by rebuild-and-diff (444 files
byte-identical; negative control held; restore verified). rc from EXIT-trap artifacts, never a pipe.

## Result

| arm | rc | cells | registered prediction |
| --- | --- | --- | --- |
| **A** — anchored ancestor I planted | **1** | 4 passed, then `default persona written` FAILED | **A-59 FAILS — matched** |
| **B** — no anchored ancestor | **0** | **23 passed** | **B-59 PASSES — matched** |

- **A-LEAK — matched.** `$BASE/anchored/.cotal/agents/default.md` **exists** after the run. The
  persona is affirmatively found in the wrong place. *A red alone would show only that the cell
  noticed something; this shows where the write went.*
- **A-REACHED — matched.** Exactly cells 50, 54, 55, 56 passed before the failure.
- **A-UNREACHED — matched.** 63, 65, 66, 67, 71, 75, 76, 80, 81, 82, 86, 88 never ran.
- **B-NOLEAK — matched.** No `.cotal` above the project in the clean base.

**No refutation condition fired.** The red is the shared-anchor escape, and nothing else.

## I did not run the polluting control, and substituted one I own

The obvious control runs under the real `/tmp`, which **writes into `/tmp/.cotal` — a tree several
lanes are reading.** fm-webconsole declined a comparable arm on that ground and was right. So I
planted the anchored ancestor myself under `/var/tmp` (verified: no `.cotal` at any ancestor up to
`/`; `/tmp` and `/home/david` both carry one, which is why neither was the base). **Both arms are
mine and neither touched shared state.**

Corroboration that existed before I ran anything: **`/tmp/.cotal/agents/default.md`, mtime 22:28
today** — the leaked persona itself, on disk, from somebody else's run.

## ⚠️ ARM B IS THE POST-FIX WORLD, AND IT IS WHY THE FIX IS DANGEROUS ALONE

**Arm B is what the suite does once the anchor is fixed: rc 0, 23 green.** So cells 76 and 82
(`still launches nothing`) did execute and did pass there. **The measurement below shows they cannot
fail.**

### The vacuity, measured rather than read — driven through `dist`, with both controls

    cwd = <proj>,  COTAL_HOME = <sandbox home>
      PRODUCT writes:  <proj>/.cotal/manager.pid      <- MANAGER_PID_PATH()
      SUITE asserts:   <sandbox home>/manager.pid     <- join(home, "manager.pid")
      same path?       false
      COTAL_HOME a prefix of the product path?  false

    NEGATIVE CONTROL — change COTAL_HOME entirely:  product path DOES NOT MOVE
    POSITIVE CONTROL — change cwd instead:          product path MOVES to <proj2>/.cotal/manager.pid

**The manager pid path is CWD-derived, not `COTAL_HOME`-derived.** So cells **54, 76 and 82 assert
the absence of a path the product cannot write under any configuration.** They are not weak; they
are incapable of failing. Confirmed by planting a real pidfile where the product writes it — the
cells' predicate does not notice — with the inverse control (plant one where the suite looks) showing
the predicate does fire when its own path is populated.

> **A red can hide a vacuous cell indefinitely, because nobody audits the cells downstream of a
> failure.** The inverse of a vacuous pass: *a green can be vacuous because nobody reads greens; a
> cell behind a red can be vacuous because nobody reaches it.*

**This converts fm-orchestrator's ruling from a judgement call into a measured precondition: the
anchor fix and a mutation on cells 54/76/82 must land together, or the fix trades a visible failure
for an invisible one.**

## Scope, and what this does NOT establish

- The suite is **fm-webconsole's** and I did not modify it. The fix is theirs; this is the arm.
- Arm B could have failed later than 59 for unrelated reasons (cell 65 installs `@cotal-ai/web` and
  the run strips `PATH`). **It did not — but I registered in advance that a later failure would not
  have refuted the anchor claim**, and that stands either way.
- **Deep-import note:** `@cotal-ai/cli`'s `exports` map exposes only `"."`, so the probe reached
  `MANAGER_PID_PATH` through a `file://` URL to `dist/lib/manager-proc.js`. That is the compiled
  artifact the CLI actually runs, which is the point — but it is a deep import the package does not
  publish, and a future `exports` change would break the probe without breaking the product.
