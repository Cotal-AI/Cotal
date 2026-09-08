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
failure count without a total is not enough. A progress-derived total also needs an explicit
`completionMarker` on the terminal line. Configs whose suite launches a repository entrypoint
may declare it in `executes`; the declaration is accepted only when the suite passes that entrypoint
to a Node, tsx, or node-pty subprocess and the command builds each mutated package reached through
it.
