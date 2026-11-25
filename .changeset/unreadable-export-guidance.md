---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Show recovery guidance in `cotal doctor auth` when an exported credential's JWT claims cannot be read. The command suggests restoring the file or confirming the intended grants before minting to a new private path, without changing the exit status.
