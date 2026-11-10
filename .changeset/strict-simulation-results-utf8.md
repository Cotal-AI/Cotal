---
"@cotal-ai/runtime": patch
---

Refuse simulation results files that are not valid UTF-8 instead of silently replacing their bytes.
The refusal names the handler file and asks for UTF-8 text before any simulation runs.
