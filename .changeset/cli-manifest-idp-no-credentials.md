---
"@cotal-ai/cli": patch
---

A manifest `broker.idp` that embeds credentials (`https://user:pass@host/...` or the token form `https://token@host/...`) is now refused with `broker.idp must not embed credentials`, the same rule `broker.servers` already followed. It used to pass validation, and `cotal up -f --dry-run` printed the credential in its plan line. The refusal names the field and never repeats the value.
