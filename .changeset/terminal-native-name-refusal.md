---
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
"@cotal-ai/connector-core": patch
---

Release an unissued native connection request only after a matching terminal name refusal, so a conflicting name does not trap later requests. Preserve unknown recovery state and explain legacy name conflicts without displaying server text. Opt in to terminal refusals without changing older clients' behavior, and distinguish hosted name refusal from local automatic numbering.
