---
"@cotal-ai/cli": patch
---

`cotal service stop`, `restart` and `uninstall` and a named `cotal down <service>…` name what kept
them from asking when they refuse for a missing `--yes`: `--json`, `--no-input`,
`COTAL_NO_PROMPT=1` or no interactive terminal.
