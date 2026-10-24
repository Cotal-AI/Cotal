---
"@cotal-ai/cli": patch
---

A malformed `--on` on `persona` names the command to rerun, such as
`cotal persona create <name> --on <instance>`, instead of one that repeats `--on`.
