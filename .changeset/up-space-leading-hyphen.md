---
"@cotal-ai/cli": patch
---

`cotal up --space` refuses a name that starts with `-` with `USAGE_INVALID`, exit 1, before anything is started or written. The stack passes its space to its own children as `--space <name>`, so such a name started a broker whose delivery daemon then exited.
