# Registered predictions — the `TMPDIR` discrimination on `setup-pure-live.smoke.ts`

**Registered BEFORE running. Lane tip `8ae0d438`.** Suite is `bin/smoke/setup-pure-live.smoke.ts`,
**run UNMODIFIED** — it is fm-webconsole's to fix and I am not touching it.

Arm proposed by `fmh-rev-fg5`, which found the red. Taken by me because **the arm and the report
should have the same author**.

## What I am discriminating

`fmh-rev-fg5` measured the suite dying at EXIT-trap **rc 1**. The claim is that the cause is the
shared-anchor escape: the suite's project dir is created under `tmpdir()`, `/tmp/.cotal` exists, and
`findCotalRoot` (`auth-paths.ts:396-406`) walks **up** from the project to `/tmp`, so the default
persona is written to `/tmp/.cotal/agents/` instead of `<proj>/.cotal/agents/`, and line **59**
(`ok("default persona written", existsSync(join(proj, ".cotal", "agents", "default.md")))`) fails.

**Physical corroboration already on disk before I ran anything:** `/tmp/.cotal/agents/default.md`,
mtime 22:28 today. That is the leaked persona, not an inference about one.

## I am NOT running the polluting arm, and that is a deliberate substitution

The obvious control — run it under the real `/tmp` — **writes into `/tmp/.cotal`, a tree several
lanes are currently reading.** fm-webconsole declined a comparable arm on exactly this ground and
was right. So instead of inheriting `fmh-rev-fg5`'s red as my control, **I build the anchored
ancestor myself**, under a base I own. Same mechanism, no shared pollution, and both arms are mine.

## Predicted cells, BY NAME

Base: `/var/tmp/fmh-anchor-arm-<n>` — **verified to have no `.cotal` at any ancestor up to `/`**
(checked `/var/tmp`, `/`, and every level between; `/tmp` and `/home/david` DO carry one, which is
why neither is the base).

### ARM A — POSITIVE CONTROL: an anchored ancestor that I planted

`TMPDIR=$BASE/anchored/sub`, with `$BASE/anchored/.cotal/` created first.

- **A-59 FAILS**: line 59 `default persona written` is the failing cell, and the suite exits **rc 1**.
- **A-LEAK**: `$BASE/anchored/.cotal/agents/default.md` EXISTS after the run — the persona is
  affirmatively found in the wrong place. *A red alone would only show the cell noticed something;
  this shows where the write went.*
- **A-REACHED**: cells 50, 54, 55, 56 are reached and pass **before** the failure.
- **A-UNREACHED**: cells 63, 65, 66, 67, 71, 75, **76**, 80, 81, **82**, 86, 88 are NEVER REACHED.
  76 and 82 are the `still launches nothing` cells.

### ARM B — NEGATIVE CONTROL: no anchored ancestor

`TMPDIR=$BASE/clean/sub`, nothing anchored anywhere above it.

- **B-59 PASSES**: line 59 passes, and the run proceeds past it.
- **B-NOLEAK**: no `.cotal` directory is created anywhere in `$BASE/clean` above the project dir.

## Refutation conditions, stated in advance

- If **A-59 does not fail**, my causal story is wrong: the red is not the anchor escape.
- If **B-59 also fails**, the anchor is not the discriminator and the arm has proved nothing.
- If **A-LEAK is absent while A-59 fails**, the cell is red for some other reason and I must not
  report the anchor as the cause.

## What this arm CANNOT establish, said before the result

**Arm B may still fail LATER than 59** — cell 65 installs `@cotal-ai/web` into a sandboxed config
dir and can fail on network or npm, and the run strips `PATH`. **A later failure in arm B does NOT
refute the anchor claim, and I will not report it as one.** The claim under test is scoped to
**cell 59 and nothing else**.

**Neither arm grades the vacuous cells.** 54/55/76/82 test `join(home, "manager.pid")` where `home`
is `COTAL_HOME` — but the product writes the pid to `<root>/.cotal/manager.pid` via `cotalPath()`,
which never consults `COTAL_HOME`. **They assert the absence of a path the product cannot write
under any configuration, so they pass without checking anything.** Arm B making the suite green
would make that worse, not better — which is exactly why fm-orchestrator ruled that the anchor fix
and a mutation on those cells must land together. **Establishing that vacuity is a separate
measurement and I am not claiming it here.**

## Build provenance

`dist` proven current at `8ae0d438` by rebuild-and-diff (444 files byte-identical, negative control
held, restore verified). This suite drives `bin/cotal.ts` → `@cotal-ai/cli` → `dist/index.js`, so
without that it would be ungraded.
