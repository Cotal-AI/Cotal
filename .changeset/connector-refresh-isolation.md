---
"@cotal-ai/cli": patch
"@cotal-ai/connector-codex": patch
---

Cotal update refreshes other connectors even when one fails. It reports completed refreshes and failures separately. If Codex cannot load its moved marketplace and Cotal cannot repair it, update gives recovery instructions and exits nonzero after attempting the other connector refreshes.
