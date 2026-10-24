---
"@cotal-ai/cli": patch
---

A mistyped command, leading flag, subcommand or option now names the nearest one: `cotal stauts`
suggests `status`, `cotal --jsno` suggests `--json`, `cotal persona shwo` suggests `show` and
`cotal status --jsno` suggests `--json`. A word near nothing keeps the plain line.
