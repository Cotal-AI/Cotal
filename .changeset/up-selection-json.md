---
"@cotal-ai/cli": patch
---

`cotal up --json` on a controller root now gives `result.selection`: `current`, the space selected after the start, and `changed`, true when this `up` selected its own space because no space was selected. The docs also say that a space stays selected through its `cotal down`.
