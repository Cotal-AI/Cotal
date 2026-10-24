---
"@cotal-ai/cli": patch
---

A word that names none of a command's subcommands, and is near none of them, is now refused with the
subcommands the command takes, so `cotal telemetry bogus` names the levels `off`, `minimal` and
`regular`.
