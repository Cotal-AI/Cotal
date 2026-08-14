# Scope 1 — render-only repair. MEASURED.

Fix `65372e7e`. Mutation predictions `86742b65`, registered **before** the mutation. All runs at
exact HEAD with a tracked-clean tree; exit codes from EXIT-trap artifacts, never a pipe.

## Result

| run | rc | cells |
| --- | --- | --- |
| repair cells at `65372e7e` (fixed) | **0** | **10 passed, 0 failed** |
| pre-fix instrument `finding5-A-wedge.sh` against the fix | 1 | **7 passed, A4 FAILED — the intended flip** |
| repair cells under mutation M-R1 | 1 | **5 passed, 5 failed** |
| repair cells after restore | **0** | **10 passed, 0 failed** |

## R1 — proved by an instrument written before the fix existed

`.lane/finding5-A-wedge.sh` is unchanged since `0afeb6ce`; it asserts the OLD behaviour. Run against
the fixed code on a real manager:

- `A1` still PASS — the manager still serves
- `A5a`/`A5` still PASS — the wedge is still reversible
- `A2` still PASS — `kill -0` ok, `/proc/<pid>/status State: T`
- `A3` still PASS — the probe still refuses
- **`A4` FAILED** — the card no longer claims `manager running`

**Every fact about the world is unchanged and only the render moved.** That is the selectivity
result, and it is stronger than a cell written to agree with the repair would be. The card now reads:

    · manager  local process present (pid 2057534 · .cotal/manager.pid) · serving not checked

## Mutation M-R1 — the five named cells, and the five named non-discriminators

M-R1 restores the exact pre-fix render (`managerUp()` → `running`/`not running · start:`). **Predicted
by name at `86742b65` before the mutation was applied. The outcome matched exactly:**

**RED, as predicted:** `R4`, `R2`, `R3`, `R7a`, `R7`.
**GREEN, as predicted and explicitly non-discriminating for this mutation:** `R2b`, `R7c`, `R0`, plus
the inverse controls `R5`, `R6`.

**No survivors among the predicted-red, and no unpredicted reds.** M-R1 is **NOT equivalent** — it
changes rendered output on the `alive`, `unknown` and `unattributable` arms, which is exactly what
the five red cells assert. The mutant row was verbatim `✓ manager running`, the original defect.

**Why the non-discriminators were named in advance:** `R2b` and `R7c` guard a different regression
(a future arm that recommends an action on `alive`, or ticks green on `unattributable`). Had I
reported only "the mutant went red", their staying green would read as laxity in the cells rather
than as cells aimed elsewhere.

Restore verified by `git status --porcelain` (clean) and re-measured green — **git was the recovery,
not the tool.**

## ⚠️ The hazard that nearly invalidated all of it: `dist/`, not `src/`

**`implementations/cli/package.json` declares `"main": "./dist/index.js"`. `bin/cotal.ts` → `run.js`
→ `@cotal-ai/cli` resolves to `dist/`. There is no `paths` alias to `src`. So ANY smoke that drives
the real `cotal` binary is measuring `dist/`, and `dist/` is GITIGNORED — a local build artifact with
no provenance in git whatsoever.**

Measured, not theorised: after editing `setup.ts` to shorten the rendered source path, **two
consecutive runs of the repair cells reported 10/10 green while still printing the OLD absolute
path.** The cells were passing against a build of a source version I had already changed. I noticed
only because the rendered text disagreed with the file I had just written.

**This is the exact thing this lane's own rule forbids: a green that cannot be re-derived from the
source at a named hash.** The green was real; its provenance was not. Had the disagreement been in
behaviour rather than in a visible string, nothing would have surfaced it.

**Consequence for the earlier finding-5 re-derivation:** those runs drove `cotal` too, so they also
measured `dist/`. I had made no CLI source edits before `b68417ff`, so `dist` should have
corresponded to the committed tree — **but I did not verify that at the time, and "should have" is
not a measurement.** The defect-A and defect-B reproductions stand on their own because the mutation
above independently confirms the same code path from source; I am recording the gap rather than
asserting it away.

**Standing procedure for this lane from now on:** `pnpm build` before any live CLI measurement, and
state in the artifact that the build followed the source under test. Filed separately as
`.internal/anomalies/2026-08-14-cli-smokes-measure-dist-not-src.md` because it applies to every lane
running live CLI suites tonight.

## A third instrument error of mine, recorded

The first repair-cells run reported `R2 FAIL` and `R3 FAIL`. The text was present — **`note()` WRAPS
a long row across several box lines and my reader took `head -1`.** A cell that reads part of a
surface measures part of a surface. Fixed to read the whole row; the same run then showed the row
was three lines long with an absolute path in it, which is why the rendered source is now relative.

**So the false FAIL was useful**: it was wrong about the fix and right about the design.

## Not measured

Manager health — scope 2, ruled separate. `meshStatus`'s hardcoded `DEFAULT_SERVER`. The A5-pin,
still carried open. §4. `pnpm smoke:ci` or any other suite. **No gate.**
