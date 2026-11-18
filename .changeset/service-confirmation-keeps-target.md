---
"@cotal-ai/cli": patch
---

A `cotal service` stop, restart, remove or uninstall that cannot ask for confirmation now prints a confirming command with `--space` and the `--instance` and `--with-agents` it was given. The printed command used to leave them out, so for `--space <other>` it stopped or removed the selected space's service of that name instead.
