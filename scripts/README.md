# Repository scripts

## Pull request CI verdicts

Do not infer that a pull request head is green from zero pending checks, zero failures, or Code
Quality alone. GitHub can expose an exact head without minting the repository's ordinary workflow
runs.

Use the repository guard instead:

```bash
pnpm pr-head-gate <pull-request-number>
```

It derives the expected named set from `.github/workflows/*.yml` at the exact head, including
`pull_request` path filters, then grades only runs attached to that pull request and head. Its
non-green categories are distinct:

- **missing**: an expected workflow run was never created for this PR and head
- **pending**: the run exists but is queued or running
- **failing**: the run completed without a `success` conclusion, including `neutral` or `skipped`

The path-filter reader understands the declaration and glob forms used in this repository. A new
form it does not understand is an error, not a silently ignored or literal filter.

The guard is read-only. It does not drain GitHub's queue, retrigger a run, or diagnose or fix the
external scheduler that creates workflow runs.
