# M-R5 — MEASURED. Answers reviewer finding 2, and took three attempts to measure honestly.

The finding: *"R13 is blind to the same provenance defect one call below `managerRow()`."* Review
mutated `managerLivenessSnapshot` to probe the first read's pid and return a second read's pid for
display, left `managerRow` untouched, and `mutation-proof` reported **SURVIVED** against 32 marks.

## The decisive comparison — one mutant, one tree, one run

| suite | against the mutant | after restore |
| --- | --- | --- |
| `liveness-snapshot` (behavioural, new) | **12 passed, 2 failed** — `S5`, `S6` | **14 passed, 0 failed** |
| `finding5-repair-cells.sh` (structural) | **32 passed, 0 failed — BLIND** | 32 passed, 0 failed |

The structural suite is not merely weaker here; it is **green about a program that renders a pid it
never probed**. That is the reviewer's claim re-derived at my own tip rather than inherited from
theirs, and it is the evidence that the new cell closed a real hole rather than an imagined one.

`mutation-proof` independently: **KILLED**, red and named on `S5`, 12 marks against a baseline of 14.

## Predicted first, at `f3eb1997`, before the mutant existed

`prediction.txt` was committed before the file was touched. Predicted RED: **`S5`, `S6`** — by name,
not by count. Predicted GREEN: the other 12, including `S4` deliberately, because the probe still
receives the correct pid and only a cell watching the RETURN can see the defect. Predicted the
repair cells would stay **32/0**. **Every one of those held.**

Non-equivalence was registered in advance: the mutant returns a pid different from the probed one
whenever a writer interleaves. Had `S5`/`S6` stayed green the mutation would still have been
non-equivalent and the suite simply BLIND — to be recorded as a blind cell, not re-run until it
looked right.

## ⚠️ It took THREE attempts, and the first two are preserved because of how they failed

**Attempt 1** (`398d1aa6`): the repair cells take `ART_DIR` and refuse without it. The runner did not
set it, so both arms died at that line having run **no cells** — and each exited **1**. Read from
the exit code alone, `1` looks exactly like *the structural suite went red on the mutant*: the
opposite of the truth, and the reading that flatters the fix. **The suite documents that window in
its own header. I wrote a caller that walked straight into it.**

**Attempt 2** (`5ee295c8`): `ART_DIR` supplied, `FG5_SCRATCH` not. This time the suite reported it
correctly — `ran=0/32`, `SUITE INCOMPLETE — This is NOT a clean run`, stamped into its own artifact
by the cell-count pin and the EXIT trap. **That is the whole difference the attempt-1 repair bought:
the same underlying failure, no longer able to impersonate a result.** The runner now takes the
verdict from the artifact the suite stamps itself and reports a missing stamp as NOT MEASURED.

Attempt 2 also returned `restore-clean.rc=1`, which had nothing to do with the restore: the runner
overwrites its own **tracked** artifact files, so an unscoped `git diff --quiet HEAD` was answering
about its own footprint. Scoped to the mutated file, it is **0**.

## Evidence — READ BACK from the repository, not written from intent

Verify with `git ls-files .lane/mutants/M-R5/`; do not trust this table.

⚠️ **AND THAT VERIFICATION IS NOT ENOUGH, WHICH REVIEW HAD TO TELL ME.** `git ls-files` answers
*is this file tracked*. It does not answer *does this file contain what the table says*. The row for
the build logs claimed a command line; both logs are **zero bytes**. So the previous version of this
section fixed the failure mode where a file is silently absent and reproduced the one where the
description is wrong — with the read-back ceremony making it look settled.

**The rule needs its second half: an evidence inventory is a claim about the repository AND about
the contents, and `git ls-files` establishes only the first.** The contents were checked with
`wc -c` after review pointed at them, which is how the zero bytes were confirmed.

The first failure in this sequence was the other half: an inventory written from intent, where
`git add` exited 0 having silently skipped two `*.log` files while this file listed them as
preserved. `.lane/mutants/.gitignore` carries the scoped negation that stops that one recurring.
**Two failures, one file, opposite directions — present but undescribed, then described but empty.**

Contents, not just tracking:

    git ls-files .lane/mutants/M-R5/ | while read -r f; do printf '%8s  %s\n' "$(wc -c < "$f")" "$f"; done

| file | what it is |
| --- | --- |
| `prediction.txt` | committed at `f3eb1997`, BEFORE the mutant was applied |
| `base-sha.txt` | the base recorded by the run itself |
| `mutant.diff` | the exact diff, `git diff` against that base |
| `run.sh` | the whole sequence, re-runnable |
| `mutant-liveness.out` / `.rc` | **12 passed, 2 failed** / rc `1` |
| `mutant-repair.out` / `.verdict` | **32 passed, 0 failed** / `rc=0 ran=32/32` |
| `restore-liveness.out` / `.rc` | 14 passed, 0 failed / rc `0` |
| `restore-repair.out` / `.verdict` | 32 passed, 0 failed / `rc=0 ran=32/32` |
| `restore-clean.rc` | `0` — the mutated file matches HEAD again |
| `build.log`, `restore-build.log` | ⚠️ **ZERO BYTES.** `tsc` printed nothing on success and the runner redirected output without recording the command. An earlier version of this table said they carried the command line — **they never did** |
| `build.rc`, `restore-build.rc` | the build exit codes, written separately: both `0` |

`repair-artifacts/` holds the stamps the repair suite writes about itself, which is where its rc is
read from — never from the shell's view of the command.

## What this does NOT prove

- **The race has still never been observed in the wild.** The probe is a synthetic writer occupying
  the window; nothing here schedules a real manager restart into it.
- `liveness-snapshot` **measures source**, deliberately: the helper is not reachable through the
  package's `exports` map, so no suite can get at it through the specifier the shipped CLI resolves.
  The invariant is established in the tree, not in the built artifact.
- The structural cells `R13`/`R13a` are **not repaired** and are not claimed to be. They remain
  bounded by the function they scan. The behavioural cell is what covers the call path; the
  structural ones stay as a cheap statement of intent at the caller.
