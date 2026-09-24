---
"@cotal-ai/connector-codex": patch
---

Dismiss a Codex turn's batch on an operator interrupt instead of redelivering it, and stop folding an unknown terminal status into "interrupted". Presence writes from the Codex host go out in call order, so a turn that fails or asks for approval in the tick it started no longer loses its condition to its own start.
