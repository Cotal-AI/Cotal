---
"@cotal-ai/manager": patch
---

Reject empty or whitespace-only `model`, `role` and `agent` arguments to `define-persona` with `bad-request` naming the field, before writing a persona. Previously, empty strings were silently treated as omitted and whitespace-only role or agent values were saved for a later launch to reject. Omitted fields retain their existing inheritance behavior. The manager cluster document advances to revision 46.
