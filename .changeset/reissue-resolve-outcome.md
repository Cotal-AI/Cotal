---
"@cotal-ai/core": minor
---

State the effect outcome structurally when a bind refusal's re-issue cannot be resolved. The
error's message asserted the command had not run while its `outcome` field was absent, and an
omitted outcome must be read as `unknown` (SPEC 13.3), so the prose and the field a caller keys
on disagreed on the one path whose purpose is to be conclusive.
