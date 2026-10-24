---
"@cotal-ai/cli": patch
---

`cotal down`, `cotal history clear`, `cotal channel remove` and `cotal persona remove` name what kept
them from asking when they refuse for a missing `--yes`: `--json`, `--no-input`, `COTAL_NO_PROMPT=1`
or no interactive terminal. On a terminal with `--no-input` they used to say confirmation was needed
outside an interactive terminal.
