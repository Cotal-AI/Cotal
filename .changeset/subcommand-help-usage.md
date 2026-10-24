---
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
"@cotal-ai/runtime": patch
---

Every subcommand's help now gives its whole usage, from `cotal` through its arguments, such as
`cotal channel set <name>` and `cotal persona create <name>`, and lists only the options that
subcommand takes. `help history clear` no longer prints a usage without `cotal history`, and the
usages of `meshes`, `personas`, `spawn`, `backup`, `describe`, `invoke`, `actor`, `agent-bearer`
and `service-endpoint` now start with `cotal`.
