---
"@cotal-ai/manager": patch
---

Control refusals no longer end in internal plan labels such as `(F5)`, `(F5(b))`, `(F3)` or "the #29 auth-trigger slice"; each ends after its reason. The same labels are gone from the manager's comments and the service-ops smoke's check names.
