---
"@cotal-ai/connector-core": patch
---

When `cotal_spawn` cannot check a helper's model pin because the caller may not inspect that helper, the result now tells the caller to ask the user instead. The one-off and unknown-outcome results point to goal-result through `cotal_invoke` instead of spelling out the call.
