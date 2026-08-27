---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
---

Honor the persona file's `agent:` frontmatter when picking the spawn harness. The key existed in
half the fleet's personas but no code path read it: it swept into the verbatim `meta` bag, and both
launch paths resolved the connector before the persona file was loaded, so `COTAL_DEFAULT_AGENT`
silently beat a deliberate per-persona pin (a `jcode` persona ran `claude` with no complaint).

The harness now resolves once, on every spawn path, as: explicit `--agent` flag > persona `agent:` >
`COTAL_DEFAULT_AGENT` > the product default. That is the precedence `model:` and `variant:` already
have, keeping the env var a *default* rather than an override. On `--detach` the CLI now threads
only an explicit flag across the control plane (flag and env used to collapse into one field, which
made file precedence structurally unreachable manager-side); the manager loads the persona file
before resolving its connector and applies the precedence itself. A pin naming an unregistered
connector fails the spawn loudly with the connector install hint (no silent fallback).

`saveAgentFile` round-trips the field, so a runtime `cotal_persona` redefine preserves a pin.
Docs updated (`agent-files.md`, `connectors.md`, `cli.md`, `config.md`).
