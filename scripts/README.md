# Repository scripts

## Pull request CI verdicts

Do not infer that a pull request head is green from zero pending checks, zero failures, or Code
Quality alone. GitHub can expose an exact head without minting the repository's ordinary workflow
runs.

Use the repository guard instead:

```bash
pnpm pr-head-gate <pull-request-number>
```

It parses `.github/workflows/*.yml` at the exact head with the repository's YAML parser and derives
the expected named set, including `pull_request` path filters. Valid YAML forms such as flow event
lists with trailing comments are handled by the parser rather than a line reader. Invalid YAML,
invalid path-filter values, and a YAML merge key (`<<`) in `on` stop the guard. Empty trigger
collections also stop it. A non-empty scalar or mapping that names no `pull_request` event is
explicitly treated as a non-PR workflow.
It then grades only runs attached to that pull request and head. Its non-green categories are
distinct:

- **missing**: an expected workflow run was never created for this PR and head
- **pending**: the run exists but is queued or running
- **failing**: the run completed without a `success` conclusion, including `neutral` or `skipped`

The path-filter matcher understands the glob forms used in this repository. A new glob form it does
not understand is an error, not a silently ignored or literal filter.

The guard is read-only. It does not drain GitHub's queue, retrigger a run, or diagnose or fix the
external scheduler that creates workflow runs.

## Full local check

`pnpm check` runs the typecheck, the docs gate, `pnpm test`, `pnpm smoke:ci` and the `:live` suites
in order through `scripts/check.mjs`. A failing step does not stop the run: every step runs, and the
closing summary lists each step that failed with its exit status, so one red suite cannot hide the
steps after it. The run exits 1 when any step failed. A step the root manifest does not define is
refused before anything runs.

No workflow runs `pnpm check`, and some of its `:live` steps are on no CI shard.
`pnpm smoke:gate-inventory` lists those with the reason each one is left out.

## Docs checks

`pnpm check:docsbundle` is the CI docs gate. It runs three checks, and each proves less than a
green run suggests:

- `check:docs-voice` grades prose style in `docs/` and never reads source.
- `check:docs-literals` reads each code span in `docs/` that looks like emitted operator prose
  (four or more lowercase words, not a command) and fails when no string or template literal in
  shipped source holds it. A substituted value is written as a placeholder such as `<id>`, and it
  must stand where the source substitutes one. Strings are read from the JavaScript each file
  compiles to, so a comment, a type or an ambient declaration does not count as emitting a line.
  Pages are read with a Markdown parser (`marked`), so text in a fenced or indented code block is
  never a candidate, in a block quote or list item as well as at the top level. A capitalized,
  short or punctuation-heavy quote is not a candidate, so a rename of one of those is still caught
  only by review.
- `check-docs-bundle.mjs` proves the generator turns the pages into a bundle that is not hollow.
  It does not prove that the pages agree with the code.

## Mutation coverage

Run every tracked mutation config from the current checkout:

```bash
pnpm mutation-coverage
```

Pass config paths to grade only those files. The validator examines every selected config even when
an earlier one is refused, its command fails, or its completed output has no trustworthy executed
cell total. It exits non-zero after the full selection and reports the checkout HEAD with counts for
enumerated, examined, graded, refused-with-reason, unparsed, and command-failed configs.

`unparsed` means the suite command completed but did not prove how many cells it executed. A zero
failure count without a total is not enough. The instrument grades only a number the suite printed:
a tally, a checks-passed count, or a complete N/N fraction. Progress ticks are not an executed-cell
total. `completionMarker` locates the line that may carry that fraction, and only after the tally
and checks-passed arms have been tried. Presence of the marker string is never itself a total. A
complete fraction on the marker line still grades when other text shares that line; the selftest
records that as a limitation, not as a completion claim. Configs whose suite launches a repository
entrypoint may declare it in `executes`; the declaration is accepted only when the suite passes
that entrypoint to a Node, tsx, or node-pty subprocess and the command builds each mutated package
reached through it. An `executes`-only config diff is coverage metadata, not a proof-definition
change: mutation-reproof names it as a metadata-only exclusion instead of re-proving the live
kill set.

## Mutation reproof

`node scripts/mutation-reproof.mjs --base <commit>` re-proves the mutation fixtures a diff selects.
A fatal verdict or a pre-red command that the diff caused fails it. A command that was already red
at the base, or a fixture whose run was inconclusive, is reported without failing, as long as at
least one selected fixture produced a kill.

`node scripts/mutation-reproof.mjs --all` is the scheduled full sweep, run in shards. It grades the
health of the whole tree, so every proven fixture in the shard must produce a kill. A fixture that
is pre-red, inconclusive, or graded nothing fails the sweep and is named on the
`MUTATION REPROOF FLOOR ERODED` line, or on the `ZERO DISCRIMINATED, COULD NOT` line when no fixture
killed. That failure opens or comments on the `ci:mutation-reproof` tracking issue.

## Mutation reproof budget

`mutation-reproof` takes `--budget-minutes <n>`, and the workflow passes one below each shard's step
timeout. Selection does not estimate fixture cost, so one shard can draw more proof work than its
step can finish. Without a budget the step was killed from outside: no tally, no word about the
fixtures that never ran, and a mutant left in the tree. With one, each `mutation-proof` child gets
the deadline as `--deadline <epoch-ms>`. At the deadline it cuts the running suite, kills that
suite's process group, puts the mutant back, names the mutations it did not reach and exits 5. The
reproof then prints `MUTATION REPROOF BUDGET EXHAUSTED`, names each selected fixture as cut short or
not run, and exits 1. That result is UNMEASURED. It is never a pass. A fatal verdict whose base
comparison cannot finish in the budget is reported as an unmeasured transition with the budget as
its reason.

A process that left the suite's group survives a group kill, and anything spawned `detached` does.
Every process a proof starts carries the proof's mark in `MUTATION_PROOF_RUN`. After any timed-out
run the proof kills every process still carrying its mark and prints what it killed and what
survived. mutation-reproof does the same for the commands it runs itself: the snapshot install and
build, and the head and base runs of a pre-red comparison. It reads the marks from `/proc`, so on
other platforms it says it did not look. A process that rebuilt its environment without the mark is
out of reach. A seat custodian is one: it keeps only `PATH` and `COTAL_RUN`.

Each proof child also gets `--restore-deadline`, one minute before the reproof would kill it. An
`afterRestore` rebuild still running at that instant is killed by the proof and its mutation is
reported as RESTORE FAILED, because the derived artefacts may still be built from the mutant.
