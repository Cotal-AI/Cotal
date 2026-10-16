---
"cotal-ai": minor
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
"@cotal-ai/auth": minor
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-opencode": minor
---

`cotal ps`, `cotal models` and `cotal runtimes` write one structured document with `--json` and a plain report with `--plain`, and exit by the structured outcome table. A read that could not read part of what it was asked for, such as a manager that did not answer a census, is `partial` and exits 4, with a warning naming each part it could not read. A mesh a structured command cannot resolve or reach is refused before any request with a stable code (`TARGET_NOT_FOUND`, `TARGET_UNAVAILABLE`, `AUTH_REQUIRED`, `PERMISSION_DENIED`, `DEPENDENCY_UNAVAILABLE` and others) and exits 2, and under `--json` that refusal is one envelope. The user-auth provider names why it could not issue credentials (signed out, service unavailable, refused), so that refusal carries the right code. `cotal version --json` with an unreadable extensions manifest is now `partial` and exits 4. A connector's `listModels` can return `unavailable` with a reason when its install has no catalog to list; the manager then reports it `supported: false` instead of a failed read, and OpenCode 2.x does so instead of failing `cotal models`.

Breaking: `cotal ps --json` writes one envelope whose `result.items` are the manager rows, instead of one row per line. An incomplete manager census exits 4 instead of 1, and a mesh `ps` or `models` cannot reach exits 2 instead of 1. The human reports of `ps`, `models` and `runtimes` are tables, and `ps --wide` prints one record per seat. See the upgrade notes.
