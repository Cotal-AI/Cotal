---
"@cotal-ai/cli": patch
---

`cotal update` no longer treats a supervisor from another install of the same space as custody for this install. A supervisor whose command resolves inside this install is still read.
