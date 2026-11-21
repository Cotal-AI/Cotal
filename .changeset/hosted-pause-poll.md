---
"@cotal-ai/runtime": patch
"cotal-ai": patch
---

Hosted workflows no longer replay their journals while polling for a timer fire or settlement that has not arrived. The host still checks the current journal before acting on a fire or returning a settlement.
