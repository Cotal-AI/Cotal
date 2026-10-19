---
"@cotal-ai/manager": patch
---

The manager's `define-persona` command now refuses an empty or whitespace-only `model`, `role` or `agent` with `bad-request` naming the field, the same way `spawn` refuses a blank optional field. An empty value used to be dropped as if it were omitted, while a whitespace-only `role` or `agent` was written into the persona file and failed later, at endpoint construction or spawn. Omit the field to leave it unset, or unchanged on a redefine.
