# Repository scripts

## Pull request CI verdicts

Do not infer that a pull request head is green from zero pending checks, zero failures, or Code
Quality alone. GitHub can expose an exact head without minting the repository's ordinary workflow
runs.

Use the repository guard instead:

```bash
pnpm pr-head-gate <pull-request-number>
```

It parses `.github/workflows/*.yml` at the exact head as YAML, derives the expected named set,
including `pull_request` path filters, then grades only runs attached to that pull request and head.
Comments, quoted values, flow or block collections, and aliases keep their YAML meaning. Its
non-green categories are distinct:

- **missing**: an expected workflow run was never created for this PR and head
- **pending**: the run exists but is queued or running
- **failing**: the run completed without a `success` conclusion, including `neutral` or `skipped`

The path-filter reader understands the declaration and glob forms used in this repository. A
`pull_request` option, value type, expression, or glob it cannot evaluate is an error, not a
silently ignored declaration or literal filter.

The guard is read-only. It does not drain GitHub's queue, retrigger a run, or diagnose or fix the
external scheduler that creates workflow runs.
