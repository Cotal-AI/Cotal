---
"@cotal-ai/cli": patch
---

`cotal update` no longer treats a supervisor from another install of the same space as custody for this install. A supervisor whose command names this install's CLI entry is still read, and a node binary or loader argument does not hide it.
