---
"@cotal-ai/cli": patch
---

`cotal down --preserve-state` now checks each presence row once, where it is read, for a card with a non-empty string `id` and a string `name`, and refuses the cut as malformed when one fails. A deleted key is still the only row it reads as absent. Before, a participant that wrote `null`, `false`, `0` or `""` under its own presence key was skipped as if its key were deleted, so the cut preserved state while that participant was live, and a card with no `name` was named `undefined (<id>)` in the unmanaged-endpoints refusal.
