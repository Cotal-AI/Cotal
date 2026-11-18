---
"@cotal-ai/cli": patch
---

`cotal history clear`, `channel remove`, `persona remove` and `endpoint remove` that cannot ask for confirmation now print a confirming command with the `--space`, `--server` and `--creds` they were given. The printed command used to leave them out, so for `--space <other>` it cleared or removed the selected space's history, channel, persona or reference instead.
