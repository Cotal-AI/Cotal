---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
---

Preserve the pre-submission compatibility refusal when a followed action's service does not advertise goal-result. Narrowed discovery keeps the action required and lets the existing follow preflight report the upgrade notice and not-executed outcome without publishing a mutation.
