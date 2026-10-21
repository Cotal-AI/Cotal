---
"@cotal-ai/cli": patch
---

`cotal up --space <name>` now refuses with `TARGET_UNAVAILABLE`, exit 2, when that space was prepared in another folder, and with `CONFLICT`, exit 2, in a folder that is already another space's root. Both refusals used to exit 3 as `OPERATION_UNKNOWN`, although neither changes anything. The message names the root, and `error.remedy` gives the next step.
