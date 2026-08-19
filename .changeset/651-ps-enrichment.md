---
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

`cotal ps --wide` / `--json`: surface the per-seat facts the manager already records. The agent row now carries the model pin (and variant), `cwd`, `pid`, spawner, and the owning manager's instance id and host, all optional so an unrecorded fact (no model pinned; a runtime that owns no real process) serializes absent, never fabricated. Bare `ps` output is unchanged; `--wide` prints one dim facts line under each seat; `--json` prints the manager's row verbatim, one object per line, with instance headers on stderr. No new collection path: every field was already held in the manager's spawn-time record.
