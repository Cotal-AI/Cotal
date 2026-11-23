---
"@cotal-ai/cli": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/core": patch
---

Cotal update refreshes other connectors even when one fails. It reports completed refreshes and failures separately. If Codex cannot load its marketplace and Cotal cannot repair it, update gives recovery instructions and exits nonzero. After an upgrade, the package migration warns about this Codex problem without blocking `cotal setup`.
