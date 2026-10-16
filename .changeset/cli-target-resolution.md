---
"cotal-ai": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

A command picks its space the same way in every surface, and says what to do when it cannot.

- With no `--space`, `--server` or `--creds`, nothing selected and no project in the folder, a command that several running spaces could serve asks which one on a terminal. The answer targets that one run and leaves the selection alone; cancelling exits 0. A script, `--json` and `--no-input` still refuse with `TARGET_AMBIGUOUS`.
- A refused target, a broker that does not answer and refused credentials carry what to run next in `error.remedy`, apart from `error.message`. The one-line wording elsewhere is unchanged apart from punctuation.
- `cotal up -f` and `cotal spawn -f` refuse a `--space` that names another space than the manifest's, before anything is written. Before, `--space` replaced the manifest's space.
- `cotal sync` writes one envelope with `--json` and a plain report with `--plain`. An account whose catalog could not be refreshed is named in a `CATALOG_UNAVAILABLE` warning and makes the result partial (exit 4); when none could be refreshed it refuses with `DEPENDENCY_UNAVAILABLE`.
- `@cotal-ai/workspace` exports `workspaceErrorParts`, and a `ConnectRefusal` can carry its message and remedy apart.
